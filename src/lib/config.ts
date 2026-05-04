import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expandUser, pathExistsSync } from "./fs.js";
import type {
  CommandBridgeSettings,
  ExternalDependencySettings,
  ExecutionSettings,
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

export const GLOBAL_CONFIG_PATH = "~/.tns/config.json";

type ConfigObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMergeConfig<T extends ConfigObject>(base: T, override: ConfigObject): T {
  const output: ConfigObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const prior = output[key];
    if (isPlainObject(prior) && isPlainObject(value)) {
      output[key] = deepMergeConfig(prior, value);
    } else {
      output[key] = value;
    }
  }
  return output as T;
}

function readConfigObject(path: string): ConfigObject {
  const resolved = expandUser(path);
  const content = readFileSync(resolved, "utf-8");
  return JSON.parse(content) as ConfigObject;
}

function deepEqualConfig(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stripInternalConfig(config: Record<string, unknown>): ConfigObject {
  const clone = JSON.parse(JSON.stringify(config)) as ConfigObject;
  delete clone._config_path;
  delete clone._program_from_compiled;
  return clone;
}

function pruneInheritedConfig(value: unknown, inherited: unknown): unknown {
  if (deepEqualConfig(value, inherited)) {
    return undefined;
  }
  if (!isPlainObject(value) || !isPlainObject(inherited)) {
    return value;
  }
  const output: ConfigObject = {};
  for (const [key, child] of Object.entries(value)) {
    const pruned = pruneInheritedConfig(child, inherited[key]);
    if (pruned !== undefined) {
      output[key] = pruned;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function arrayStartsWithPrefix(value: unknown[], prefix: unknown[]): boolean {
  if (prefix.length > value.length) {
    return false;
  }
  return prefix.every((item, index) => deepEqualConfig(item, value[index]));
}

function compactInheritedSkillbaseSources(clean: ConfigObject, global: ConfigObject): ConfigObject {
  const localSkillbases = clean.skillbases;
  const globalSkillbases = global.skillbases;
  if (!isPlainObject(localSkillbases) || !isPlainObject(globalSkillbases)) {
    return clean;
  }
  const localSources = localSkillbases.sources;
  const globalSources = globalSkillbases.sources;
  if (!Array.isArray(localSources) || !Array.isArray(globalSources) || !arrayStartsWithPrefix(localSources, globalSources)) {
    return clean;
  }
  const next = {
    ...clean,
    skillbases: {
      ...localSkillbases,
      sources: localSources.slice(globalSources.length),
    },
  };
  return next;
}

function findUpConfig(startDir = process.cwd()): string | null {
  let current = resolve(startDir);
  while (true) {
    const candidate = resolve(current, "tns_config.json");
    if (pathExistsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function globalConfigPath(): string {
  return process.env.TNS_GLOBAL_CONFIG || GLOBAL_CONFIG_PATH;
}

export function resolveConfigPath(path?: string): string {
  if (path) {
    return expandUser(path);
  }
  const local = findUpConfig();
  if (local) {
    return local;
  }
  const global = expandUser(globalConfigPath());
  if (pathExistsSync(global)) {
    return global;
  }
  throw new Error("config not found: pass --config, run inside a TNS workspace, or create ~/.tns/config.json");
}

export function loadGlobalConfig(): Partial<TnsConfig> {
  const path = expandUser(globalConfigPath());
  if (!pathExistsSync(path)) {
    return {};
  }
  return readConfigObject(path) as Partial<TnsConfig>;
}

export function loadConfig(path?: string): TnsConfig {
  const resolved = resolveConfigPath(path);
  const globalConfig = loadGlobalConfig() as ConfigObject;
  const localConfig = readConfigObject(resolved);
  const config = deepMergeConfig(globalConfig, localConfig) as unknown as TnsConfig;
  const globalSkillbases = globalConfig.skillbases;
  const localSkillbases = localConfig.skillbases;
  if (isPlainObject(globalSkillbases) && isPlainObject(localSkillbases)) {
    const globalSources = globalSkillbases.sources;
    const localSources = localSkillbases.sources;
    if (Array.isArray(globalSources) && Array.isArray(localSources)) {
      config.skillbases = {
        ...(config.skillbases ?? {}),
        sources: [...globalSources, ...localSources] as NonNullable<TnsConfig["skillbases"]>["sources"],
      };
    }
  }

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

export function configForWrite(config: TnsConfig | Record<string, unknown>, path?: string): Record<string, unknown> {
  let clean = stripInternalConfig(config as Record<string, unknown>);
  const configPath = path ?? (config as TnsConfig)._config_path;
  const global = loadGlobalConfig() as ConfigObject;
  if (!configPath || Object.keys(global).length === 0) {
    return clean;
  }
  if (resolve(expandUser(configPath)) === resolve(expandUser(globalConfigPath()))) {
    return clean;
  }
  clean = compactInheritedSkillbaseSources(clean, global);
  const pruned = (pruneInheritedConfig(clean, global) ?? {}) as ConfigObject;
  if ("workspace" in clean) {
    pruned.workspace = clean.workspace;
  }
  if ("product_doc" in clean) {
    pruned.product_doc = clean.product_doc;
  }
  return pruned;
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

export function executionSettings(config: TnsConfig): Required<ExecutionSettings> {
  const cfg = config.execution ?? {};
  return {
    long_running: {
      agent: cfg.long_running?.agent ?? "tns-executor",
      workspace: cfg.long_running?.workspace ?? "primary",
      persists_state: cfg.long_running?.persists_state ?? true,
      must_report_to: cfg.long_running?.must_report_to,
      gc_after_run: cfg.long_running?.gc_after_run ?? false,
      max_runtime_seconds: cfg.long_running?.max_runtime_seconds,
      max_parallel: cfg.long_running?.max_parallel ?? 1,
    },
    temporary: {
      agent: cfg.temporary?.agent ?? "tns-temp-executor",
      workspace: cfg.temporary?.workspace ?? "temporary",
      persists_state: cfg.temporary?.persists_state ?? false,
      must_report_to: cfg.temporary?.must_report_to ?? "tns-executor",
      gc_after_run: cfg.temporary?.gc_after_run ?? true,
      max_runtime_seconds: cfg.temporary?.max_runtime_seconds,
      max_parallel: cfg.temporary?.max_parallel ?? Math.max(1, Number(config.threads ?? config.thread ?? 1)),
    },
    verifier: {
      agent: cfg.verifier?.agent ?? "tns-verifier",
      workspace: cfg.verifier?.workspace ?? "primary",
      persists_state: cfg.verifier?.persists_state ?? false,
      must_report_to: cfg.verifier?.must_report_to ?? "tns-executor",
      gc_after_run: cfg.verifier?.gc_after_run ?? true,
      max_runtime_seconds: cfg.verifier?.max_runtime_seconds ?? 600,
      max_parallel: cfg.verifier?.max_parallel ?? 1,
    },
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
    parallel: item.parallel ? {
      group: item.parallel.group,
      thread: item.parallel.thread,
      resource: item.parallel.resource,
      depends_on: Array.isArray(item.parallel.depends_on) ? item.parallel.depends_on.map(String) : [],
      exclusive: Boolean(item.parallel.exclusive ?? false),
      starts_suspended: Boolean(item.parallel.starts_suspended ?? false),
      executor_class: item.parallel.executor_class,
      verifier: item.parallel.verifier,
      skills: Array.isArray(item.parallel.skills) ? item.parallel.skills.map(String) : [],
      verifier_skills: Array.isArray(item.parallel.verifier_skills) ? item.parallel.verifier_skills.map(String) : [],
      workspace: item.parallel.workspace,
      merge_policy: item.parallel.merge_policy,
      timeout_seconds: item.parallel.timeout_seconds,
    } : undefined,
  }));
}

export function programSettings(config: TnsConfig): FsmProgramSettings | null {
  const cfg = config.program;
  if (!cfg || !Array.isArray(cfg.states) || cfg.states.length === 0 || !cfg.entry) {
    return null;
  }
  const requestedThreads = Math.max(1, Number(cfg.threads ?? cfg.thread ?? config.threads ?? config.thread ?? cfg.parallel?.max_threads ?? 1));
  return {
    entry: cfg.entry,
    context: cfg.context ?? {},
    states: normalizeStates(cfg.states),
    max_steps: Math.max(1, Number(cfg.max_steps ?? 100)),
    threads: requestedThreads,
    parallel: {
      mode: cfg.parallel?.mode ?? (requestedThreads > 1 ? "auto" : "off"),
      max_threads: Math.max(1, Number(cfg.parallel?.max_threads ?? requestedThreads)),
    },
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
