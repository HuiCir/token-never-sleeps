import { execaSync } from "execa";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonSync } from "../lib/fs.js";
import { getEffectivePermissionMode } from "../lib/config.js";
import { makeAgentError } from "../lib/errors.js";
import type { TnsConfig, ExecutorResult, VerifierResult, AgentOutput, AgentUsage } from "../types.js";
import which from "which";
const whichSync = which.sync;

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

export function schemaByName(name: string): Record<string, unknown> {
  if (name === "executor") return EXECUTOR_SCHEMA;
  if (name === "verifier") return VERIFIER_SCHEMA;
  return {};
}

function requireClaude(): string {
  const claude = whichSync("claude");
  if (!claude) throw new Error("claude CLI not found in PATH");
  return claude;
}

export function buildCommonClaudeArgs(config: TnsConfig, workspace: string): string[] {
  const claude = requireClaude();
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const args: string[] = [
    claude,
    "-p",
    "--plugin-dir",
    pluginRoot,
    "--add-dir",
    resolve(workspace),
    "--permission-mode",
    getEffectivePermissionMode(config),
    "--effort",
    config.effort || "high",
    "--output-format",
    "json",
  ];
  if (config.max_budget_usd != null) {
    args.push("--max-budget-usd", String(config.max_budget_usd));
  }
  return args;
}

export function runAgent(
  config: TnsConfig,
  workspace: string,
  agent: string,
  schema: Record<string, unknown>,
  prompt: string
): AgentOutput {
  const args = buildCommonClaudeArgs(config, workspace);
  args.push("--agent", agent, "--json-schema", JSON.stringify(schema), prompt);

  let proc: { exitCode: number | null; stderr: string; stdout: string };
  try {
    proc = execaSync(args[0], args.slice(1), {
      cwd: workspace,
      encoding: "utf8",
      captureOutput: true,
    }) as { exitCode: number; stderr: string; stdout: string };
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string };
    throw makeAgentError(agent, { stderr: e.stderr || "", stdout: e.stdout || "" });
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
  let payload: ExecutorResult | VerifierResult;

  try {
    payload = JSON.parse(resultText) as unknown as ExecutorResult;
  } catch {
    const structured = outer.structured_output;
    if (structured && typeof structured === "object" && Object.keys(structured).length > 0) {
      payload = structured as ExecutorResult | VerifierResult;
    } else {
      payload = normalizeSchemaResult(config, workspace, schema, resultText) as unknown as ExecutorResult | VerifierResult;
    }
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

export function normalizeSchemaResult(
  config: TnsConfig,
  workspace: string,
  schema: Record<string, unknown>,
  text: string
): Record<string, unknown> {
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
    proc = execaSync(args[0], args.slice(1), {
      cwd: workspace,
      encoding: "utf8",
      captureOutput: true,
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