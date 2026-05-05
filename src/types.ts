// Types for TNS Runner

export interface Section {
  id: string;
  title: string;
  anchor: string;
  body: string;
  status: "pending" | "in_progress" | "needs_fix" | "done" | "blocked";
  attempts: number;
  verified_at: string | null;
  last_summary: string;
  last_review: string;
  current_step: string;
}

export interface Manifest {
  started_at: string;
  product_doc: string;
  refresh_anchor_at: string;
  refresh_hours: number;
  refresh_minutes: number | null;
  refresh_seconds: number | null;
}

export interface Window {
  index: number;
  start: Date;
  end: Date;
}

export interface StatePaths {
  workspace: string;
  state_dir: string;
  manifest: string;
  sections: string;
  handoff: string;
  reviews: string;
  freeze: string;
  activity: string;
  artifacts: string;
  tmux: string;
  runtime: string;
  approvals: string;
  exploration: string;
  diagnostics: string;
  command_runs: string;
  section_outputs_dir: string;
  compiled_dir: string;
  compiled_program: string;
  compiler_review: string;
  task_plan_review: string;
  lock_events: string;
  tool_events: string;
  injection_events: string;
  agent_runs_dir: string;
  hook_events: string;
  runner_log: string;
  gateway_dir: string;
  gateway_inbox: string;
  gateway_events: string;
  gateway_status: string;
  gateway_clients: string;
  gateway_tasks: string;
  gateway_responses_dir: string;
}

export interface TmuxSettings {
  enabled: boolean;
  auto_create: boolean;
  session_name: string;
  window_name: string;
  socket_name: string;
  manage_runner: boolean;
  runner_window_name: string;
}

export interface WorkflowNode {
  id: string;
  agent: string;
  schema: string;
  prompt_mode: string;
  transitions: Transition[];
  default_transition?: Transition;
}

export interface Transition {
  field?: string;
  equals?: unknown;
  not_equals?: unknown;
  "in"?: unknown[];
  truthy?: boolean;
  next?: string;
  set_status?: string;
  summary_field?: string;
  review_field?: string;
  review_value?: string;
  append_review?: boolean;
  set_verified_at?: boolean;
  end?: boolean;
}

export interface WorkflowSettings {
  entry: string;
  max_steps_per_run: number;
  agents: WorkflowNode[];
}

export interface PermissionProfile {
  permission_mode?: string;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  allowed_bash_commands?: string[];
  disallowed_bash_commands?: string[];
  requires_approval?: string | null;
  workspace_only?: boolean;
  restricted_paths?: string[];
}

export interface SectionPermissionRule {
  match_title?: string;
  match_step?: string;
  profile: string;
}

export interface PermissionSettings {
  default_profile: string;
  profiles: Record<string, PermissionProfile>;
  section_profiles?: SectionPermissionRule[];
}

export interface MonitorSettings {
  heartbeat_seconds: number;
  max_agent_runtime_seconds: number;
  kill_grace_seconds: number;
}

export interface ExplorationSettings {
  enabled: boolean;
  allow_taskx: boolean;
  taskx_filename: string;
  max_rounds_per_window: number;
  agent: string;
  plan_taskx?: boolean;
  taskx_min_score?: number;
  taskx_branch_dir?: string;
  require_taskx_deliverables?: boolean;
}

export type ValidatorStage = "preflight" | "pre_step" | "post_step" | "post_run";

export interface PreflightSettings {
  required_files?: string[];
  required_directories?: string[];
}

export interface ValidatorSpec {
  id: string;
  stage: ValidatorStage;
  kind: "file_exists" | "directory_exists" | "text_regex" | "text_not_regex" | "json_path_equals" | "command_set";
  path?: string;
  match_title?: string;
  match_step?: string;
  pattern?: string;
  flags?: string;
  json_path?: string;
  equals?: string | number | boolean | null;
  command_set?: string;
  description?: string;
  review_prefix?: string;
}

export interface CommandInvocationSpec {
  exec: string;
  args?: string[];
  cwd?: string;
  timeout_seconds?: number;
  env?: Record<string, string>;
  allowed_exit_codes?: number[];
  description?: string;
}

export interface CommandSetSpec {
  id: string;
  command?: string[];
  commands?: CommandInvocationSpec[];
  cwd?: string;
  timeout_seconds?: number;
  env?: Record<string, string>;
  allowed_exit_codes?: number[];
  description?: string;
}

export interface CommandHookRule {
  stage: ValidatorStage;
  match_title?: string;
  match_step?: string;
  command_sets: string[];
}

export interface CommandBridgeSettings {
  command_sets: Record<string, CommandSetSpec>;
  hooks?: CommandHookRule[];
}

export interface PolicyAction {
  action: "continue" | "block_section" | "mark_needs_fix" | "freeze" | "fail_run";
  freeze_seconds?: number;
  review_prefix?: string;
}

export interface PolicySettings {
  preflight_failure?: PolicyAction;
  command_failure?: PolicyAction;
  outside_workspace_violation?: PolicyAction;
  validator_failure?: Partial<Record<ValidatorStage, PolicyAction>>;
}

export interface StructuredOutputSettings {
  write_section_outputs: boolean;
}

export interface ExternalToolSpec {
  name: string;
  required?: boolean;
  purpose?: string;
}

export interface ExternalSkillSpec {
  name: string;
  required?: boolean;
  purpose?: string;
  source_id?: string;
  source_kind?: "skillbase" | "plugin" | "skills_dir";
  source_path?: string;
  path?: string;
  content_hash?: string;
  installed_at?: string;
  registry_package?: string;
}

export interface ExternalMcpSpec {
  server: string;
  resource?: string;
  required?: boolean;
  purpose?: string;
}

export interface ExternalDependencySettings {
  tools?: ExternalToolSpec[];
  skills?: ExternalSkillSpec[];
  mcp?: ExternalMcpSpec[];
}

export interface ExecutorClassSettings {
  agent: string;
  workspace: "primary" | "temporary";
  persists_state: boolean;
  must_report_to?: string;
  gc_after_run?: boolean;
  max_runtime_seconds?: number;
  max_parallel?: number;
}

export interface ExecutionSettings {
  long_running?: ExecutorClassSettings;
  temporary?: ExecutorClassSettings;
  verifier?: ExecutorClassSettings;
}

export interface InjectionProfile {
  skills?: string[];
  external_skill_paths?: string[];
  add_dirs?: string[];
  description?: string;
}

export interface StageInjectionRule {
  match_mode?: "compile" | "plan" | "executor" | "verifier" | "exploration";
  match_title?: string;
  match_step?: string;
  profile: string;
}

export interface InjectionSettings {
  default_profile?: string | null;
  profiles: Record<string, InjectionProfile>;
  rules?: StageInjectionRule[];
}

export interface SkillbaseSourceSettings {
  id?: string;
  path: string;
  kind?: "auto" | "skillbase" | "plugin" | "skills_dir";
  enabled?: boolean;
  priority?: number;
}

export interface SkillbaseSettings {
  sources?: SkillbaseSourceSettings[];
  use_default_sources?: boolean;
  selection?: SkillbaseSelectionSettings;
}

export interface SkillbaseSelectionSettings {
  mode?: "off" | "explicit" | "auto";
  max_matches_per_section?: number;
  min_score?: number;
  verifier_mode?: "none" | "same" | "auto";
}

export interface FsmCondition {
  path?: string;
  equals?: string | number | boolean | null;
  not_equals?: string | number | boolean | null;
  in?: Array<string | number | boolean | null>;
  truthy?: boolean;
  lt?: number;
  lte?: number;
  gt?: number;
  gte?: number;
}

export type FsmLiteral = string | number | boolean | null | string[] | number[] | boolean[] | Record<string, unknown>;

export interface FsmInstruction {
  op: "set" | "inc" | "dec" | "append" | "emit" | "if" | "while" | "thread_suspend" | "thread_resume" | "thread_interrupt" | "thread_wait";
  path?: string;
  value?: FsmLiteral;
  by?: number;
  event?: string;
  thread?: string;
  threads?: string[];
  reason?: string;
  cond?: FsmCondition;
  then?: FsmInstruction[];
  else?: FsmInstruction[];
  body?: FsmInstruction[];
  max_iterations?: number;
}

export interface FsmTransitionSpec {
  id?: string;
  to: string;
  when?: FsmCondition;
  actions?: FsmInstruction[];
  description?: string;
}

export interface FsmStateSpec {
  id: string;
  type?: "task" | "decision" | "loop" | "terminal";
  on_enter?: FsmInstruction[];
  transitions?: FsmTransitionSpec[];
  terminal?: boolean;
  description?: string;
  parallel?: FsmParallelStateSettings;
}

export interface FsmProgramSettings {
  entry: string;
  context?: Record<string, unknown>;
  states: FsmStateSpec[];
  max_steps?: number;
  thread?: number;
  threads?: number;
  parallel?: FsmParallelSettings;
}

export interface FsmParallelStateSettings {
  group?: string;
  thread?: string;
  resource?: string;
  depends_on?: string[];
  exclusive?: boolean;
  starts_suspended?: boolean;
  executor_class?: "long_running" | "temporary";
  verifier?: "none" | "state" | "batch" | "final";
  skills?: string[];
  verifier_skills?: string[];
  workspace?: "primary" | "temporary";
  merge_policy?: "none" | "handback" | "patch" | "artifact_only";
  timeout_seconds?: number;
}

export interface FsmParallelSettings {
  mode?: "off" | "auto";
  max_threads?: number;
}

export interface FsmParallelPlanItem {
  state: string;
  thread: string;
  resource: string;
  depends_on: string[];
  executor_class?: "long_running" | "temporary";
  verifier?: "none" | "state" | "batch" | "final";
  skills?: string[];
  verifier_skills?: string[];
  workspace?: "primary" | "temporary";
  merge_policy?: "none" | "handback" | "patch" | "artifact_only";
  timeout_seconds?: number;
  reason: string;
}

export interface FsmParallelBatch {
  id: string;
  states: FsmParallelPlanItem[];
}

export interface FsmParallelPlan {
  enabled: boolean;
  mode: "off" | "auto";
  max_threads: number;
  batches: FsmParallelBatch[];
  controls: FsmThreadControlPlanItem[];
  notes: string[];
}

export interface FsmThreadControlPlanItem {
  state: string;
  op: "thread_suspend" | "thread_resume" | "thread_interrupt" | "thread_wait";
  threads: string[];
  reason: string;
}

export interface CompilerPatch {
  preflight?: PreflightSettings;
  validators?: ValidatorSpec[];
  command_bridge?: CommandBridgeSettings;
  policy?: PolicySettings;
  permissions?: PermissionSettings;
  externals?: ExternalDependencySettings;
  execution?: ExecutionSettings;
  program?: FsmProgramSettings;
  skillbases?: SkillbaseSettings;
}

export interface TnsConfig {
  workspace: string;
  product_doc: string;
  thread?: number;
  threads?: number;
  refresh_hours: number;
  refresh_minutes: number | null;
  refresh_seconds: number | null;
  permission_mode: string;
  effort: string;
  success_interval_seconds: number;
  idle_interval_seconds: number;
  max_budget_usd: number | null;
  permissions?: PermissionSettings;
  tmux: TmuxSettings;
  workflow: WorkflowSettings;
  monitor?: Partial<MonitorSettings>;
  exploration?: Partial<ExplorationSettings>;
  attempts?: { max_attempts_per_section?: number };
  preflight?: PreflightSettings;
  validators?: ValidatorSpec[];
  command_bridge?: CommandBridgeSettings;
  policy?: PolicySettings;
  outputs?: Partial<StructuredOutputSettings>;
  externals?: ExternalDependencySettings;
  execution?: ExecutionSettings;
  program?: FsmProgramSettings;
  injections?: InjectionSettings;
  skillbases?: SkillbaseSettings;
  _config_path?: string;
  _program_from_compiled?: boolean;
}

export interface ExecutorResult {
  outcome: "implemented" | "needs_more_work" | "blocked";
  clean_state: boolean;
  ready_for_verification: boolean;
  summary: string;
  handoff_note: string;
  files_touched: string[];
  checks_run: string[];
  skills_used?: string[];
  blocker: string;
  commit_message: string;
}

export interface VerifierResult {
  status: "pass" | "fail" | "blocked";
  summary: string;
  checks_run: string[];
  skills_used?: string[];
  findings: string[];
  review_note: string;
}

export interface AgentUsage {
  input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  server_tool_use?: {
    web_search_requests: number;
    web_fetch_requests: number;
  };
  service_tier?: string;
}

export interface AgentOutput {
  payload: ExecutorResult | VerifierResult | ExplorationResult | CompilerResult | TaskPlanResult;
  usage: AgentUsage;
  raw: Record<string, unknown>;
}

export interface ReviewRecord {
  section: string;
  at: string;
  status: string;
  summary: string;
  review_note: string;
  findings: string[];
  step: string;
}

export interface FreezeRecord {
  reason: string;
  at: string;
  until: string;
  window: number;
}

export interface ArtifactRecord {
  section_id: string;
  section_title: string;
  path: string;
  exists: boolean;
  indexed_at: string;
  verified: boolean;
}

export interface TmuxStatus {
  enabled: boolean;
  available: boolean;
  fallback?: "direct";
  reason?: string;
  session_name?: string;
  window_name?: string;
  workspace?: string;
  tmux_path?: string;
  updated_at?: string;
  manage_runner?: boolean;
  runner_window_name?: string;
}

export interface RuntimeState {
  active: boolean;
  mode: "direct" | "tmux";
  pid: number | null;
  command: string;
  started_at: string;
  heartbeat_at: string;
  current_section: string;
  current_step: string;
  window_index: number | null;
  sleep_until: string | null;
  session_name?: string;
  runner_window_name?: string;
  current_agent?: string | null;
  agent_pid?: number | null;
  agent_started_at?: string | null;
  agent_deadline_at?: string | null;
  last_exit_at?: string;
  last_exit_reason?: string;
  recovery_note?: string;
}

export interface ActivityEvent {
  event: string;
  at?: string;
  section?: string;
  step?: string;
  agent?: string;
  result?: Record<string, unknown>;
  usage?: AgentUsage;
  error?: string;
  [key: string]: unknown;
}

export interface ValidatorResult {
  id: string;
  stage: ValidatorStage;
  ok: boolean;
  message: string;
  section_id?: string;
  step?: string;
  details?: Record<string, unknown>;
}

export interface CommandRunResult {
  id: string;
  ok: boolean;
  stage: ValidatorStage;
  section_id?: string;
  step?: string;
  command: string[];
  cwd: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
}

export interface DiagnosticsState {
  updated_at: string | null;
  last_preflight: ValidatorResult[];
  last_validator_results: ValidatorResult[];
  last_command_runs: CommandRunResult[];
  last_error: string | null;
}

export interface SectionOutputRecord {
  section_id: string;
  section_title: string;
  status: Section["status"];
  current_step: string;
  updated_at: string;
  step_results: Array<{
    node_id: string;
    payload: Record<string, unknown>;
    usage: Record<string, unknown>;
  }>;
  validator_results: ValidatorResult[];
  command_runs: CommandRunResult[];
}

export interface CompilerResult {
  summary: string;
  confidence: "high" | "medium" | "low";
  findings: string[];
  blockers: string[];
  files_touched: string[];
  checks_run: string[];
  patch: CompilerPatch;
}

export interface TaskPlanResult {
  summary: string;
  confidence: "high" | "medium" | "low";
  assumptions: string[];
  warnings: string[];
  section_count: number;
  planned_task_markdown: string;
}

export interface ToolUseEvent {
  at: string;
  agent: string;
  run_id: string;
  section_id?: string;
  step?: string;
  type: string;
  name?: string;
  id?: string;
  denied?: boolean;
  raw: Record<string, unknown>;
}

export interface ExplorationResult {
  outcome: "no_changes" | "refined" | "new_requirements" | "blocked";
  summary: string;
  handoff_note: string;
  files_touched: string[];
  checks_run: string[];
  blocker: string;
  taskx_created: boolean;
  taskx_path: string;
}

export interface ExplorationState {
  window_index: number | null;
  rounds_run: number;
  last_outcome: "idle" | "no_changes" | "refined" | "new_requirements" | "blocked";
  last_summary: string;
  last_taskx_path: string | null;
  updated_at: string | null;
}

export interface AttemptsSettings {
  max_per_section: number;
}

export interface ApprovalGrant {
  tag: string;
  granted_at: string;
  note?: string;
}

export interface ApprovalRequest {
  tag: string;
  requested_at: string;
  section_id: string;
  section_title: string;
  step: string;
  profile: string;
  reason: string;
}

export interface ApprovalState {
  granted: Record<string, ApprovalGrant>;
  pending: Record<string, ApprovalRequest>;
}
