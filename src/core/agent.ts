import { execa } from "execa";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { agentProviderSettings, getEffectivePermissionMode, monitorSettings } from "../lib/config.js";
import { makeAgentError } from "../lib/errors.js";
import { appendJsonl, writeJson } from "../lib/fs.js";
import type { StatePaths, TnsConfig, ExecutorResult, VerifierResult, ExplorationResult, CompilerResult, AgentOutput, AgentUsage, ToolUseEvent, AgentProviderName } from "../types.js";
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
  claude?: {
    bare?: boolean;
    tools?: string;
    strict_mcp_config?: boolean;
    mcp_config?: string;
    no_session_persistence?: boolean;
  };
  timeout_ms?: number;
  plugin_dir?: string;
  extra_add_dirs?: string[];
  paths?: StatePaths;
  metadata?: {
    run_id?: string;
    agent_mode?: string;
    section_id?: string;
    step?: string;
    injection_profile?: string | null;
    injected_skills?: string[];
  };
}

interface AgentInvocation {
  provider: AgentProviderName;
  args: string[];
  prompt: string;
  cleanup?: () => Promise<void>;
  parseOutput: (proc: { stdout: string; stderr: string }) => Promise<Record<string, unknown>>;
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
    skills_used: { type: "array", items: { type: "string" } },
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
    skills_used: { type: "array", items: { type: "string" } },
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

export const COMPILER_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    findings: { type: "array", items: { type: "string" } },
    blockers: { type: "array", items: { type: "string" } },
    files_touched: { type: "array", items: { type: "string" } },
    checks_run: { type: "array", items: { type: "string" } },
    patch: {
      type: "object",
      properties: {
        preflight: {
          type: "object",
          properties: {
            required_files: { type: "array", items: { type: "string" } },
            required_directories: { type: "array", items: { type: "string" } },
          },
        },
        validators: { type: "array", items: { type: "object" } },
        command_bridge: {
          type: "object",
          properties: {
            command_sets: { type: "object" },
            hooks: { type: "array", items: { type: "object" } },
          },
        },
        policy: { type: "object" },
        permissions: {
          type: "object",
          properties: {
            default_profile: { type: "string" },
            profiles: { type: "object" },
            section_profiles: { type: "array", items: { type: "object" } },
          },
        },
        externals: {
          type: "object",
          properties: {
            tools: { type: "array", items: { type: "object" } },
            skills: { type: "array", items: { type: "object" } },
            mcp: { type: "array", items: { type: "object" } },
          },
        },
        execution: {
          type: "object",
          properties: {
            long_running: { type: "object" },
            temporary: { type: "object" },
            verifier: { type: "object" },
          },
        },
        skillbases: {
          type: "object",
          properties: {
            use_default_sources: { type: "boolean" },
            sources: { type: "array", items: { type: "object" } },
          },
        },
        program: {
          type: "object",
          properties: {
            entry: { type: "string" },
            context: { type: "object" },
            states: { type: "array", items: { type: "object" } },
            max_steps: { type: "number" },
            thread: { type: "number" },
            threads: { type: "number" },
            parallel: {
              type: "object",
              properties: {
                mode: { type: "string", enum: ["off", "auto"] },
                max_threads: { type: "number" },
              },
            },
          },
        },
      },
      required: ["preflight", "validators", "command_bridge", "policy", "permissions", "externals", "program"],
    },
  },
  required: ["summary", "confidence", "findings", "blockers", "files_touched", "checks_run", "patch"],
};

export const TASK_PLANNER_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    assumptions: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } },
    section_count: { type: "number" },
    planned_task_markdown: { type: "string" },
  },
  required: ["summary", "confidence", "assumptions", "warnings", "section_count", "planned_task_markdown"],
};

export function schemaByName(name: string): Record<string, unknown> {
  if (name === "executor") return EXECUTOR_SCHEMA;
  if (name === "verifier") return VERIFIER_SCHEMA;
  if (name === "exploration") return EXPLORATION_SCHEMA;
  if (name === "compiler") return COMPILER_SCHEMA;
  if (name === "task-planner") return TASK_PLANNER_SCHEMA;
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

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function requireCommand(command: string, label: string): string {
  if (command.includes("/") || command.includes("\\")) {
    return command;
  }
  const resolved = whichSync(command, { nothrow: true });
  if (!resolved) throw new Error(`${label} CLI not found in PATH`);
  return resolved;
}

function requireClaude(): string {
  return requireCommand("claude", "claude");
}

export function buildCommonClaudeArgs(
  config: TnsConfig,
  workspace: string,
  permissions?: {
    permission_mode?: string;
    allowed_tools?: string[];
    disallowed_tools?: string[];
  },
  pluginDirOverride?: string,
  extraAddDirs?: string[],
  claudeOptions?: RunAgentOptions["claude"]
): string[] {
  const provider = agentProviderSettings(config);
  const claude = provider.name === "claude" ? requireCommand(provider.command || "claude", "claude") : requireClaude();
  const pluginRoot = pluginDirOverride || PACKAGE_ROOT;
  const permissionMode = getEffectivePermissionMode(permissions?.permission_mode ?? config.permission_mode ?? "default");
  const addDirs = Array.from(new Set([resolve(workspace), pluginRoot, ...(extraAddDirs ?? []).map((item) => resolve(item))]));
  const args: string[] = [
    claude,
    "-p",
    "--plugin-dir",
    pluginRoot,
    "--permission-mode",
    permissionMode,
    "--effort",
    config.effort || "high",
    "--output-format",
    "json",
  ];
  if (claudeOptions?.bare) {
    args.push("--bare");
  }
  if (claudeOptions?.no_session_persistence) {
    args.push("--no-session-persistence");
  }
  if (claudeOptions?.strict_mcp_config) {
    args.push("--strict-mcp-config");
  }
  if (claudeOptions?.mcp_config != null) {
    args.push("--mcp-config", claudeOptions.mcp_config);
  }
  if (claudeOptions?.tools != null) {
    args.push("--tools", claudeOptions.tools);
  }
  for (const dir of addDirs) {
    args.push("--add-dir", dir);
  }
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

function codexSandboxForPermission(mode: string): "read-only" | "workspace-write" | "danger-full-access" {
  if (mode === "bypassPermissions") {
    return "danger-full-access";
  }
  return "workspace-write";
}

function codexApprovalForPermission(_mode: string): "never" {
  return "never";
}

async function readAgentDefinition(pluginRoot: string, agent: string): Promise<string | null> {
  try {
    return await readFile(resolve(pluginRoot, "agents", `${agent}.md`), "utf-8");
  } catch {
    return null;
  }
}

function codexPrompt(agent: string, agentDefinition: string | null, schema: Record<string, unknown>, prompt: string): string {
  const definition = agentDefinition
    ? `Agent profile: ${agent}\n\n${agentDefinition}\n\n`
    : `Agent profile: ${agent}\n\nNo local agent profile file was found for this name. Follow the task prompt and schema exactly.\n\n`;
  return `${definition}Return one JSON object that strictly matches this JSON Schema. Do not wrap it in markdown and do not include prose outside the object.\n\nJSON Schema:\n${JSON.stringify(schema, null, 2)}\n\nTask prompt:\n${prompt}`;
}

function parseJsonlEvents(text: string): Record<string, unknown>[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

async function buildCodexInvocation(
  config: TnsConfig,
  workspace: string,
  agent: string,
  schema: Record<string, unknown>,
  prompt: string,
  options?: RunAgentOptions
): Promise<AgentInvocation> {
  const provider = agentProviderSettings(config);
  const codex = requireCommand(provider.command || "codex", "codex");
  const tempDir = await mkdtemp(resolve(tmpdir(), "tns-codex-"));
  const schemaPath = resolve(tempDir, "schema.json");
  const outputPath = resolve(tempDir, "last-message.json");
  await writeFile(schemaPath, JSON.stringify(schema, null, 2), "utf-8");

  const pluginRoot = options?.plugin_dir || PACKAGE_ROOT;
  const permissionMode = getEffectivePermissionMode(options?.permissions?.permission_mode ?? config.permission_mode ?? "default");
  const codexSettings = provider.codex ?? {};
  const args = [
    codex,
    "exec",
    "--cd",
    workspace,
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "--color",
    "never",
  ];

  if (provider.model) {
    args.push("--model", provider.model);
  }
  if (provider.profile) {
    args.push("--profile", provider.profile);
  }
  if (codexSettings.bypass_approvals_and_sandbox || permissionMode === "bypassPermissions") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--sandbox", codexSettings.sandbox ?? codexSandboxForPermission(permissionMode));
    args.push("--ask-for-approval", codexSettings.approval_policy ?? codexApprovalForPermission(permissionMode));
  }
  if (codexSettings.ephemeral ?? true) {
    args.push("--ephemeral");
  }
  if (codexSettings.ignore_user_config) {
    args.push("--ignore-user-config");
  }
  if (codexSettings.ignore_rules) {
    args.push("--ignore-rules");
  }
  if (codexSettings.json_events ?? true) {
    args.push("--json");
  }
  for (const dir of Array.from(new Set([pluginRoot, ...(options?.extra_add_dirs ?? [])]))) {
    args.push("--add-dir", resolve(dir));
  }
  args.push(...provider.extra_args);

  const fullPrompt = codexPrompt(agent, await readAgentDefinition(pluginRoot, agent), schema, prompt);
  args.push(fullPrompt);

  return {
    provider: "codex",
    args,
    prompt: fullPrompt,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
    parseOutput: async (proc) => {
      let result = "";
      try {
        result = await readFile(outputPath, "utf-8");
      } catch {
        result = proc.stdout.trim();
      }
      return {
        result,
        structured_output: (() => {
          try {
            return JSON.parse(result) as Record<string, unknown>;
          } catch {
            return undefined;
          }
        })(),
        events: parseJsonlEvents(proc.stdout),
        stderr: proc.stderr,
        provider: "codex",
      };
    },
  };
}

async function buildAgentInvocation(
  config: TnsConfig,
  workspace: string,
  agent: string,
  schema: Record<string, unknown>,
  prompt: string,
  options?: RunAgentOptions
): Promise<AgentInvocation> {
  const provider = agentProviderSettings(config);
  if (provider.name === "codex") {
    return buildCodexInvocation(config, workspace, agent, schema, prompt, options);
  }
  const args = buildCommonClaudeArgs(config, workspace, options?.permissions, options?.plugin_dir, options?.extra_add_dirs, options?.claude);
  args.push("--agent", agent, "--json-schema", JSON.stringify(schema), prompt);
  return {
    provider: "claude",
    args,
    prompt,
    parseOutput: async (proc) => {
      try {
        return JSON.parse(proc.stdout || "{}") as Record<string, unknown>;
      } catch {
        throw new Error(`[${agent}] returned invalid Claude JSON: ${(proc.stdout || "").slice(0, 400)}`);
      }
    },
  };
}

function extractToolUseEvents(input: unknown, acc: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(input)) {
    for (const item of input) {
      extractToolUseEvents(item, acc);
    }
    return acc;
  }
  if (!input || typeof input !== "object") {
    return acc;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.type === "string" && (record.type.includes("tool") || record.type === "server_tool_use")) {
    acc.push(record);
  }
  for (const value of Object.values(record)) {
    extractToolUseEvents(value, acc);
  }
  return acc;
}

function extractPermissionDenials(input: unknown): Array<Record<string, unknown>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return [];
  }
  const record = input as Record<string, unknown>;
  return Array.isArray(record.permission_denials)
    ? record.permission_denials.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

async function persistAgentRun(paths: StatePaths, metadata: RunAgentOptions["metadata"], outer: Record<string, unknown>, agent: string, provider: AgentProviderName, prompt: string, args: string[]): Promise<void> {
  const runId = metadata?.run_id || `${Date.now()}-${agent}`;
  await writeJson(`${paths.agent_runs_dir}/${runId}.json`, {
    run_id: runId,
    at: new Date().toISOString(),
    agent,
    mode: metadata?.agent_mode ?? "",
    section_id: metadata?.section_id ?? "",
    step: metadata?.step ?? "",
    injection_profile: metadata?.injection_profile ?? null,
    injected_skills: metadata?.injected_skills ?? [],
    provider,
    claude_args: args.slice(1),
    agent_args: args.slice(1),
    prompt,
    raw: outer,
  });
  const toolUses = extractToolUseEvents(outer);
  for (const item of toolUses) {
    const event: ToolUseEvent = {
      at: new Date().toISOString(),
      agent,
      run_id: runId,
      section_id: metadata?.section_id,
      step: metadata?.step,
      type: String(item.type ?? "tool"),
      name: typeof item.name === "string" ? item.name : undefined,
      id: typeof item.id === "string" ? item.id : undefined,
      raw: item,
    };
    await appendJsonl(paths.tool_events, event as unknown as Record<string, unknown>);
  }
  const denials = extractPermissionDenials(outer);
  for (const item of denials) {
    const event: ToolUseEvent = {
      at: new Date().toISOString(),
      agent,
      run_id: runId,
      section_id: metadata?.section_id,
      step: metadata?.step,
      type: "permission_denial",
      name: typeof item.tool_name === "string" ? item.tool_name : undefined,
      id: typeof item.tool_use_id === "string" ? item.tool_use_id : undefined,
      denied: true,
      raw: item,
    };
    await appendJsonl(paths.tool_events, event as unknown as Record<string, unknown>);
  }
}

export async function runAgent(
  config: TnsConfig,
  workspace: string,
  agent: string,
  schema: Record<string, unknown>,
  prompt: string,
  options?: RunAgentOptions
): Promise<AgentOutput> {
  const invocation = await buildAgentInvocation(config, workspace, agent, schema, prompt, options);
  const args = invocation.args;
  const monitor = monitorSettings(config);
  const heartbeatMs = monitor.heartbeat_seconds * 1000;
  const timeoutMs = options?.timeout_ms ?? (monitor.max_agent_runtime_seconds > 0
    ? monitor.max_agent_runtime_seconds * 1000
    : DEFAULT_AGENT_TIMEOUT_MS);
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
      stdin: "ignore",
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
    if (invocation.cleanup) {
      await invocation.cleanup();
    }
    throw makeAgentError(agent, { stderr: e.stderr || "", stdout: e.stdout || "" });
  }

  if (timedOut) {
    if (invocation.cleanup) {
      await invocation.cleanup();
    }
    throw new Error(timeoutMessage);
  }

  if (proc.exitCode !== 0) {
    if (invocation.cleanup) {
      await invocation.cleanup();
    }
    throw makeAgentError(agent, { stderr: proc.stderr || "", stdout: proc.stdout || "" });
  }

  let outer: Record<string, unknown>;
  try {
    outer = await invocation.parseOutput({ stdout: proc.stdout || "", stderr: proc.stderr || "" });
  } finally {
    if (invocation.cleanup) {
      await invocation.cleanup();
    }
  }

  if (options?.paths) {
    await persistAgentRun(options.paths, options.metadata, outer, agent, invocation.provider, invocation.prompt, args);
  }

  if (outer.is_error) {
    throw new Error(outer.result as string || outer.error as string || `[${agent}] returned an error`);
  }

  const resultText = (outer.result as string) || "";
  let payload: ExecutorResult | VerifierResult | ExplorationResult | CompilerResult;

  try {
    payload = JSON.parse(resultText) as unknown as ExecutorResult;
  } catch {
    const structured = outer.structured_output;
    if (structured && typeof structured === "object" && Object.keys(structured).length > 0) {
      payload = structured as ExecutorResult | VerifierResult | ExplorationResult | CompilerResult;
    } else {
      payload = await normalizeSchemaResult(config, workspace, schema, resultText) as unknown as ExecutorResult | VerifierResult | ExplorationResult | CompilerResult;
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
  const prompt = `Convert the following text into a JSON object that strictly matches the provided schema. Preserve uncertainty honestly. Return only JSON.\n\nTEXT:\n${text}`;
  const provider = agentProviderSettings(config);
  if (provider.name === "codex") {
    const invocation = await buildCodexInvocation(config, workspace, "tns-schema-normalizer", schema, prompt);
    let proc: { exitCode: number; stderr: string; stdout: string };
    try {
      proc = await execa(invocation.args[0], invocation.args.slice(1), {
        cwd: workspace,
        encoding: "utf8",
        captureOutput: true,
        timeout: DEFAULT_AGENT_TIMEOUT_MS,
        reject: false,
      }) as { exitCode: number; stderr: string; stdout: string };
    } catch (err: unknown) {
      const e = err as { stderr?: string; stdout?: string };
      await invocation.cleanup?.();
      throw new Error(`schema normalization failed: ${e.stderr || e.stdout || ""}`);
    }
    if (proc.exitCode !== 0) {
      await invocation.cleanup?.();
      throw new Error(`schema normalization failed: ${proc.stderr || proc.stdout}`);
    }
    try {
      const outer = await invocation.parseOutput(proc);
      const structured = outer.structured_output;
      if (structured && typeof structured === "object" && !Array.isArray(structured)) {
        return structured as Record<string, unknown>;
      }
      return JSON.parse(String(outer.result ?? "{}")) as Record<string, unknown>;
    } finally {
      await invocation.cleanup?.();
    }
  }

  const args = buildCommonClaudeArgs(config, workspace);
  args.push("--effort", "low", "--json-schema", JSON.stringify(schema), prompt);

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
