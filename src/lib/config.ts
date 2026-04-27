import { readFileSync } from "node:fs";
import { expandUser } from "./fs.js";
import type {
  CommandBridgeSettings,
  ExternalDependencySettings,
  InjectionSettings,
  InjectionProfile,
  StageInjectionRule,
  ExplorationSettings,
  MonitorSettings,
  PolicyAction,
  PolicySettings,
  PreflightSettings,
  FsmProgramSettings,
  FsmStateSpec,
  FsmTransitionSpec,
  FsmInstruction,
  StructuredOutputSettings,
  TnsConfig,
  TmuxSettings,
  ValidatorSpec,
  WorkflowSettings,
} from "../types.js";

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

export function preflightSettings(config: TnsConfig): PreflightSettings {
  const cfg = config.preflight ?? {};
  return {
    required_files: Array.isArray(cfg.required_files) ? cfg.required_files.map(String) : [],
    required_directories: Array.isArray(cfg.required_directories) ? cfg.required_directories.map(String) : [],
  };
}

export function validatorSettings(config: TnsConfig): ValidatorSpec[] {
  return Array.isArray(config.validators) ? config.validators : [];
}

export function commandBridgeSettings(config: TnsConfig): CommandBridgeSettings {
  const cfg = (config.command_bridge ?? {}) as Partial<CommandBridgeSettings>;
  const normalizedSets = Object.fromEntries(
    Object.entries(cfg.command_sets ?? {}).map(([id, spec]) => {
      const item = spec as CommandBridgeSettings["command_sets"][string];
      return [id, {
        ...item,
        id: item?.id ?? id,
        command: Array.isArray(item?.command) ? item.command.map(String) : undefined,
        commands: Array.isArray(item?.commands)
          ? item.commands.map((cmd) => ({
              exec: String(cmd.exec),
              args: Array.isArray(cmd.args) ? cmd.args.map(String) : [],
              cwd: cmd.cwd,
              timeout_seconds: cmd.timeout_seconds,
              env: cmd.env,
              allowed_exit_codes: cmd.allowed_exit_codes,
              description: cmd.description,
            }))
          : undefined,
      }];
    })
  );
  return {
    command_sets: normalizedSets,
    hooks: Array.isArray(cfg.hooks) ? cfg.hooks : [],
  };
}

function normalizePolicyAction(action: PolicyAction | undefined, fallback: PolicyAction): PolicyAction {
  if (!action || typeof action !== "object") {
    return fallback;
  }
  return {
    action: action.action ?? fallback.action,
    freeze_seconds: action.freeze_seconds ?? fallback.freeze_seconds,
    review_prefix: action.review_prefix ?? fallback.review_prefix,
  };
}

export interface ResolvedPolicySettings {
  preflight_failure: PolicyAction;
  command_failure: PolicyAction;
  outside_workspace_violation: PolicyAction;
  validator_failure: Record<"preflight" | "pre_step" | "post_step" | "post_run", PolicyAction>;
}

export function policySettings(config: TnsConfig): ResolvedPolicySettings {
  const cfg = config.policy ?? {};
  return {
    preflight_failure: normalizePolicyAction(cfg.preflight_failure, {
      action: "block_section",
      review_prefix: "Preflight failed",
    }),
    command_failure: normalizePolicyAction(cfg.command_failure, {
      action: "mark_needs_fix",
      review_prefix: "Command hook failed",
    }),
    outside_workspace_violation: normalizePolicyAction(cfg.outside_workspace_violation, {
      action: "block_section",
      review_prefix: "Workspace boundary violation",
    }),
    validator_failure: {
      preflight: normalizePolicyAction(cfg.validator_failure?.preflight, {
        action: "block_section",
        review_prefix: "Preflight validator failed",
      }),
      pre_step: normalizePolicyAction(cfg.validator_failure?.pre_step, {
        action: "mark_needs_fix",
        review_prefix: "Pre-step validator failed",
      }),
      post_step: normalizePolicyAction(cfg.validator_failure?.post_step, {
        action: "mark_needs_fix",
        review_prefix: "Post-step validator failed",
      }),
      post_run: normalizePolicyAction(cfg.validator_failure?.post_run, {
        action: "mark_needs_fix",
        review_prefix: "Post-run validator failed",
      }),
    },
  };
}

export function outputSettings(config: TnsConfig): StructuredOutputSettings {
  const cfg = config.outputs ?? {};
  return {
    write_section_outputs: Boolean(cfg.write_section_outputs ?? true),
  };
}

export function externalSettings(config: TnsConfig): ExternalDependencySettings {
  const cfg = config.externals ?? {};
  return {
    tools: Array.isArray(cfg.tools) ? cfg.tools.map((item) => ({
      name: String(item.name),
      required: item.required ?? true,
      purpose: item.purpose,
    })) : [],
    skills: Array.isArray(cfg.skills) ? cfg.skills.map((item) => ({
      name: String(item.name),
      required: item.required ?? true,
      purpose: item.purpose,
    })) : [],
    mcp: Array.isArray(cfg.mcp) ? cfg.mcp.map((item) => ({
      server: String(item.server),
      resource: item.resource,
      required: item.required ?? true,
      purpose: item.purpose,
    })) : [],
  };
}

export function injectionSettings(config: TnsConfig): InjectionSettings {
  const cfg = (config.injections ?? {}) as Partial<InjectionSettings>;
  return {
    default_profile: cfg.default_profile ?? null,
    profiles: Object.fromEntries(
      Object.entries(cfg.profiles ?? {}).map(([name, profile]) => [name, {
        skills: Array.isArray(profile.skills) ? profile.skills.map(String) : [],
        external_skill_paths: Array.isArray(profile.external_skill_paths) ? profile.external_skill_paths.map(String) : [],
        add_dirs: Array.isArray(profile.add_dirs) ? profile.add_dirs.map(String) : [],
        description: profile.description,
      }])
    ),
    rules: Array.isArray(cfg.rules) ? cfg.rules.map((rule) => ({
      match_mode: rule.match_mode,
      match_title: rule.match_title,
      match_step: rule.match_step,
      profile: rule.profile,
    })) : [],
  };
}

function normalizeInstructions(items: FsmInstruction[] | undefined): FsmInstruction[] {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.map((item) => ({
    ...item,
    then: normalizeInstructions(item.then),
    else: normalizeInstructions(item.else),
    body: normalizeInstructions(item.body),
  }));
}

function normalizeTransitions(items: FsmTransitionSpec[] | undefined): FsmTransitionSpec[] {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.map((item, index) => ({
    id: item.id ?? `transition-${index + 1}`,
    to: item.to,
    when: item.when,
    actions: normalizeInstructions(item.actions),
    description: item.description,
  }));
}

function normalizeStates(items: FsmStateSpec[] | undefined): FsmStateSpec[] {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.map((item) => ({
    id: item.id,
    type: item.type ?? "task",
    terminal: Boolean(item.terminal ?? item.type === "terminal"),
    description: item.description,
    on_enter: normalizeInstructions(item.on_enter),
    transitions: normalizeTransitions(item.transitions),
  }));
}

export function programSettings(config: TnsConfig): FsmProgramSettings | null {
  const cfg = config.program;
  if (!cfg || !Array.isArray(cfg.states) || cfg.states.length === 0 || !cfg.entry) {
    return null;
  }
  return {
    entry: cfg.entry,
    context: cfg.context ?? {},
    states: normalizeStates(cfg.states),
    max_steps: Math.max(1, Number(cfg.max_steps ?? 100)),
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
