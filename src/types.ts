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
  hook_events: string;
  runner_log: string;
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
}

export interface TnsConfig {
  workspace: string;
  product_doc: string;
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
  _config_path?: string;
}

export interface ExecutorResult {
  outcome: "implemented" | "needs_more_work" | "blocked";
  clean_state: boolean;
  ready_for_verification: boolean;
  summary: string;
  handoff_note: string;
  files_touched: string[];
  checks_run: string[];
  blocker: string;
  commit_message: string;
}

export interface VerifierResult {
  status: "pass" | "fail" | "blocked";
  summary: string;
  checks_run: string[];
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
  payload: ExecutorResult | VerifierResult | ExplorationResult;
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
