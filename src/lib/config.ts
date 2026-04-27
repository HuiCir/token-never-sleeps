import { readFileSync } from "node:fs";
import { expandUser } from "./fs.js";
import type { ExplorationSettings, MonitorSettings, TnsConfig, TmuxSettings, WorkflowSettings } from "../types.js";

export function loadConfig(path: string): TnsConfig {
  const resolved = expandUser(path);
  const content = readFileSync(resolved, "utf-8");
  const config = JSON.parse(content) as TnsConfig;

  const required = ["workspace"];
  const missing = required.filter((key) => !(key in config));
  if (missing.length > 0) {
    throw new Error(`config missing required keys: ${missing.join(", ")}`);
  }

  if (!config.product_doc) {
    const workspace = expandUser(config.workspace);
    config.product_doc = `${workspace}/task.md`;
  }

  (config as TnsConfig & { _config_path: string })._config_path = resolved;
  return config;
}

export function tmuxSettings(config: TnsConfig): TmuxSettings {
  const cfg = config.tmux ?? {};
  return {
    enabled: Boolean(cfg.enabled ?? false),
    auto_create: Boolean(cfg.auto_create ?? true),
    session_name: String(cfg.session_name ?? ""),
    window_name: String(cfg.window_name ?? "tns"),
    socket_name: String(cfg.socket_name ?? ""),
    manage_runner: Boolean(cfg.manage_runner ?? false),
    runner_window_name: String(cfg.runner_window_name ?? "tns-runner"),
  };
}

export function workflowSettings(config: TnsConfig): WorkflowSettings {
  const wf = config.workflow;
  if (!wf || !wf.agents || wf.agents.length === 0) {
    return {
      entry: "executor",
      max_steps_per_run: wf?.max_steps_per_run ?? 6,
      agents: [
        {
          id: "executor",
          agent: "tns-executor",
          schema: "executor",
          prompt_mode: "executor",
          transitions: [
            { field: "outcome", equals: "blocked", set_status: "blocked", summary_field: "summary", review_field: "blocker", end: true },
            { field: "clean_state", equals: false, set_status: "pending", summary_field: "summary", end: true },
            { field: "ready_for_verification", equals: false, set_status: "pending", summary_field: "summary", end: true },
            { next: "verifier" },
          ],
        },
        {
          id: "verifier",
          agent: "tns-verifier",
          schema: "verifier",
          prompt_mode: "verifier",
          transitions: [
            { field: "status", equals: "pass", set_status: "done", summary_field: "summary", review_value: "", set_verified_at: true, end: true },
            { field: "status", "in": ["fail", "blocked"], set_status: "needs_fix", summary_field: "summary", review_field: "review_note", append_review: true, end: true },
          ],
        },
      ],
    };
  }
  return wf;
}

export function monitorSettings(config: TnsConfig): MonitorSettings {
  const cfg = config.monitor ?? {};
  return {
    heartbeat_seconds: Math.max(1, Number(cfg.heartbeat_seconds ?? 30)),
    max_agent_runtime_seconds: Math.max(1, Number(cfg.max_agent_runtime_seconds ?? 30 * 60)),
    kill_grace_seconds: Math.max(1, Number(cfg.kill_grace_seconds ?? 15)),
  };
}

export function explorationSettings(config: TnsConfig): ExplorationSettings {
  const cfg = config.exploration ?? {};
  return {
    enabled: Boolean(cfg.enabled ?? false),
    allow_taskx: Boolean(cfg.allow_taskx ?? true),
    taskx_filename: String(cfg.taskx_filename ?? "taskx.md"),
    max_rounds_per_window: Math.max(1, Number(cfg.max_rounds_per_window ?? 1)),
    agent: String(cfg.agent ?? "tns-executor"),
  };
}

export function attemptsSettings(config: TnsConfig): { max_per_section: number } {
  const cfg = config.attempts ?? {};
  return {
    max_per_section: Number(cfg.max_attempts_per_section ?? 3),
  };
}

export function getEffectivePermissionMode(modeOrConfig: string | TnsConfig): string {
  const mode = typeof modeOrConfig === "string"
    ? modeOrConfig
    : (modeOrConfig.permission_mode ?? "default");
  const isRoot = typeof process.geteuid === "function" && process.geteuid() === 0;
  if (mode === "bypassPermissions" && isRoot) {
    console.log("WARNING: bypassPermissions unavailable as root, using acceptEdits");
    return "acceptEdits";
  }
  return mode;
}
