import { execa } from "execa";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getEffectivePermissionMode, monitorSettings } from "../lib/config.js";
import { makeAgentError } from "../lib/errors.js";
import type { TnsConfig, ExecutorResult, VerifierResult, ExplorationResult, AgentOutput, AgentUsage } from "../types.js";
import which from "which";
const whichSync = which.sync;

const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

interface AgentMonitorSnapshot {
  agent: string;
  pid: number | null;
  started_at: string;
  deadline_at: string;
  elapsed_ms: number;
}

interface RunAgentOptions {
  onHeartbeat?: (snapshot: AgentMonitorSnapshot) => Promise<void> | void;
  permissions?: {
    permission_mode?: string;
    allowed_tools?: string[];
    disallowed_tools?: string[];
  };
}

export const EXECUTOR_SCHEMA = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["implemented", "needs_more_work", "blocked"] },
    clean_state: { type: "boolean" },
    ready_for_verification: { type: "boolean" },
    summary: { type: "string" },
    handoff_note: { type: "string" },
    files_touched: { type: "array", items: { type: "string" } },
    checks_run: { type: "array", items: { "type": "string" } },
    blocker: { type: "string" },
    commit_message: { type: "string" },
  },
  required: ["outcome", "clean_state", "ready_for_verification", "summary", "handoff_note", "files_touched", "checks_run", "blocker", "commit_message"],
};

export const VERIFIER_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["pass", "fail", "blocked"] },
    summary: { type: "string" },
    checks_run: { type: "array", items: { type: "string" } },
    findings: { type: "array", items: { type: "string" } },
    review_note: { type: "string" },
  },
  required: ["status", "summary", "checks_run", "findings", "review_note"],
};

export const EXPLORATION_SCHEMA = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["no_changes", "refined", "new_requirements", "blocked"] },
    summary: { type: "string" },
    handoff_note: { type: "string" },
    files_touched: { type: "array", items: { type: "string" } },
    checks_run: { type: "array", items: { type: "string" } },
    blocker: { type: "string" },
    taskx_created: { type: "boolean" },
    taskx_path: { type: "string" },
  },
  required: ["outcome", "summary", "handoff_note", "files_touched", "checks_run", "blocker", "taskx_created", "taskx_path"],
};

export function schemaByName(name: string): Record<string, unknown> {
  if (name === "executor") return EXECUTOR_SCHEMA;
  if (name === "verifier") return VERIFIER_SCHEMA;
  if (name === "exploration") return EXPLORATION_SCHEMA;
  return {};
}

function schemaTypeMatches(value: unknown, expected: string): boolean {
  if (expected === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  if (expected === "array") return Array.isArray(value);
  if (expected === "string") return typeof value === "string";
  if (expected === "boolean") return typeof value === "boolean";
  if (expected === "number") return typeof value === "number";
  if (expected === "integer") return Number.isInteger(value);
  if (expected === "null") return value === null;
  return true;
}

function validatePayloadSchema(payload: unknown, schema: Record<string, unknown>, path = "$"): string[] {
  const errors: string[] = [];
  const expectedType = schema.type;
  if (Array.isArray(expectedType)) {
    if (!expectedType.some((item) => schemaTypeMatches(payload, String(item)))) {
      return [`${path}: expected one of ${expectedType.join(", ")}, got ${typeof payload}`];
    }
  } else if (typeof expectedType === "string" && !schemaTypeMatches(payload, expectedType)) {
    return [`${path}: expected ${expectedType}, got ${typeof payload}`];
  }

  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && !enumValues.includes(payload)) {
    errors.push(`${path}: expected one of ${enumValues.join(", ")}, got ${String(payload)}`);
  }

  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const objectPayload = payload as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!(String(key) in objectPayload)) errors.push(`${path}.${String(key)}: missing required field`);
    }
    const properties = schema.properties;
    if (typeof properties === "object" && properties !== null && !Array.isArray(properties)) {
      for (const [key, childSchema] of Object.entries(properties as Record<string, unknown>)) {
        if (key in objectPayload && typeof childSchema === "object" && childSchema !== null && !Array.isArray(childSchema)) {
          errors.push(...validatePayloadSchema(objectPayload[key], childSchema as Record<string, unknown>, `${path}.${key}`));
        }
      }
    }
  }

  if (Array.isArray(payload) && typeof schema.items === "object" && schema.items !== null && !Array.isArray(schema.items)) {
    payload.forEach((item, index) => {
      errors.push(...validatePayloadSchema(item, schema.items as Record<string, unknown>, `${path}[${index}]`));
    });
  }

  return errors;
}

function requireClaude(): string {
  const claude = whichSync("claude");
  if (!claude) throw new Error("claude CLI not found in PATH");
  return claude;
}

export function buildCommonClaudeArgs(
  config: TnsConfig,
  workspace: string,
  permissions?: {
    permission_mode?: string;
    allowed_tools?: string[];
    disallowed_tools?: string[];
  }
): string[] {
  const claude = requireClaude();
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const permissionMode = getEffectivePermissionMode(permissions?.permission_mode ?? config.permission_mode ?? "default");
  const args: string[] = [
    claude,
    "-p",
    "--plugin-dir",
    pluginRoot,
    "--add-dir",
    resolve(workspace),
    "--permission-mode",
    permissionMode,
    "--effort",
    config.effort || "high",
    "--output-format",
    "json",
  ];
  if (permissions?.allowed_tools && permissions.allowed_tools.length > 0) {
    args.push("--allowedTools", permissions.allowed_tools.join(","));
  }
  if (permissions?.disallowed_tools && permissions.disallowed_tools.length > 0) {
    args.push("--disallowedTools", permissions.disallowed_tools.join(","));
  }
  if (config.max_budget_usd != null) {
    args.push("--max-budget-usd", String(config.max_budget_usd));
  }
  return args;
}

export async function runAgent(
  config: TnsConfig,
  workspace: string,
  agent: string,
  schema: Record<string, unknown>,
  prompt: string,
  options?: RunAgentOptions
): Promise<AgentOutput> {
  const args = buildCommonClaudeArgs(config, workspace, options?.permissions);
  args.push("--agent", agent, "--json-schema", JSON.stringify(schema), prompt);
  const monitor = monitorSettings(config);
  const heartbeatMs = monitor.heartbeat_seconds * 1000;
  const timeoutMs = monitor.max_agent_runtime_seconds > 0
    ? monitor.max_agent_runtime_seconds * 1000
    : DEFAULT_AGENT_TIMEOUT_MS;
  const killGraceMs = monitor.kill_grace_seconds * 1000;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const deadlineAt = new Date(startedAtMs + timeoutMs).toISOString();

  let proc: { exitCode: number | null; stderr: string; stdout: string };
  let timedOut = false;
  let timeoutMessage = "";
  try {
    const child = execa(args[0], args.slice(1), {
      cwd: workspace,
      encoding: "utf8",
      captureOutput: true,
      timeout: undefined,
      reject: false,
    }) as ReturnType<typeof execa>;

    const emitHeartbeat = () => {
      if (!options?.onHeartbeat) {
        return;
      }
      void Promise.resolve(options.onHeartbeat({
        agent,
        pid: child.pid ?? null,
        started_at: startedAt,
        deadline_at: deadlineAt,
        elapsed_ms: Date.now() - startedAtMs,
      })).catch(() => {});
    };

    emitHeartbeat();
    const timer = setInterval(() => {
      emitHeartbeat();
      if (!timedOut && Date.now() - startedAtMs >= timeoutMs) {
        timedOut = true;
        timeoutMessage = `[${agent}] watchdog timeout after ${Math.ceil(timeoutMs / 1000)}s; runner will retry`;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode == null) {
            child.kill("SIGKILL");
          }
        }, killGraceMs).unref();
      }
    }, heartbeatMs);
    timer.unref();

    try {
      proc = await child as { exitCode: number; stderr: string; stdout: string };
    } finally {
      clearInterval(timer);
    }
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string };
    throw makeAgentError(agent, { stderr: e.stderr || "", stdout: e.stdout || "" });
  }

  if (timedOut) {
    throw new Error(timeoutMessage);
  }

  if (proc.exitCode !== 0) {
    throw makeAgentError(agent, { stderr: proc.stderr || "", stdout: proc.stdout || "" });
  }

  let outer: Record<string, unknown>;
  try {
    outer = JSON.parse(proc.stdout || "{}");
  } catch {
    throw new Error(`[${agent}] returned invalid Claude JSON: ${(proc.stdout || "").slice(0, 400)}`);
  }

  if (outer.is_error) {
    throw new Error(outer.result as string || outer.error as string || `[${agent}] returned an error`);
  }

  const resultText = (outer.result as string) || "";
  let payload: ExecutorResult | VerifierResult | ExplorationResult;

  try {
    payload = JSON.parse(resultText) as unknown as ExecutorResult;
  } catch {
    const structured = outer.structured_output;
    if (structured && typeof structured === "object" && Object.keys(structured).length > 0) {
      payload = structured as ExecutorResult | VerifierResult | ExplorationResult;
    } else {
      payload = await normalizeSchemaResult(config, workspace, schema, resultText) as unknown as ExecutorResult | VerifierResult | ExplorationResult;
    }
  }
  const schemaErrors = validatePayloadSchema(payload, schema);
  if (schemaErrors.length > 0) {
    throw new Error(`[${agent}] returned payload that does not match schema: ${schemaErrors.slice(0, 8).join("; ")}`);
  }

  const usage: AgentUsage = {
    input_tokens: (outer.usage as AgentUsage)?.input_tokens ?? 0,
    cache_read_input_tokens: (outer.usage as AgentUsage)?.cache_read_input_tokens ?? 0,
    output_tokens: (outer.usage as AgentUsage)?.output_tokens ?? 0,
    server_tool_use: (outer.usage as AgentUsage)?.server_tool_use,
    service_tier: (outer.usage as AgentUsage)?.service_tier,
  };

  return { payload, usage, raw: outer as Record<string, unknown> };
}

export async function normalizeSchemaResult(
  config: TnsConfig,
  workspace: string,
  schema: Record<string, unknown>,
  text: string
): Promise<Record<string, unknown>> {
  const args = buildCommonClaudeArgs(config, workspace);
  args.push(
    "--effort",
    "low",
    "--json-schema",
    JSON.stringify(schema),
    `Convert the following text into a JSON object that strictly matches the provided schema. Preserve uncertainty honestly. Return only JSON.\n\nTEXT:\n${text}`
  );

  let proc: { exitCode: number; stderr: string; stdout: string };
  try {
    proc = await execa(args[0], args.slice(1), {
      cwd: workspace,
      encoding: "utf8",
      captureOutput: true,
      timeout: DEFAULT_AGENT_TIMEOUT_MS,
      reject: false,
    }) as { exitCode: number; stderr: string; stdout: string };
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string };
    throw new Error(`schema normalization failed: ${e.stderr || e.stdout || ""}`);
  }

  if (proc.exitCode !== 0) {
    throw new Error(`schema normalization failed: ${proc.stderr || proc.stdout}`);
  }

  const outer = JSON.parse(proc.stdout || "{}");
  const resultText = (outer.result as string) || "";
  return JSON.parse(resultText);
}
