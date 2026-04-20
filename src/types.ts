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
  hook_events: string;
  runner_log: string;
}

export interface GitSettings {
  enabled: boolean;
  default_branch: string;
  record_all_branches: boolean;
  rollback_on_quota_exhaustion: boolean;
  auto_init: boolean;
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

export interface QuotaSettings {
  provider: "none" | "rolling_usage" | "command";
  window_token_budget: number | null;
  minimum_remaining: number | null;
  enforce_freeze: boolean;
  freeze_on_unknown: boolean;
  command: string;
}

export interface QuotaResult {
  ok: boolean;
  reason?: string;
  remaining?: number;
  unit?: string;
  observed_at?: string;
}

export interface WorkflowNode {
  id: string;
  agent: string;
  schema: string;
  prompt_mode: string;
  transitions: Transition[];
}

export interface Transition {
  field?: string;
  equals?: string;
  not_equals?: string;
  "in"?: string[];
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

export interface NotificationEmailSettings {
  enabled: boolean;
  method: string;
  to: string[];
  from: string;
  subject_prefix: string;
  smtp: {
    host: string;
    port: number;
    username: string;
    password: string;
    starttls: boolean;
    ssl: boolean;
  };
}

export interface NotificationRemoteSettings {
  enabled: boolean;
  root: string;
  report_task_start: boolean;
  report_step_progress: boolean;
  report_task_complete: boolean;
  node_bin: string;
}

export interface NotificationSettings {
  claude_code_remote: NotificationRemoteSettings;
  email: NotificationEmailSettings;
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
  executor_agent: string;
  verifier_agent: string;
  max_budget_usd: number | null;
  git: GitSettings;
  quota: QuotaSettings;
  tmux: TmuxSettings;
  workflow: WorkflowSettings;
  notifications: NotificationSettings;
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
  payload: ExecutorResult | VerifierResult;
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

export interface ActivityEvent {
  event: string;
  at?: string;
  section?: string;
  step?: string;
  agent?: string;
  quota?: QuotaResult;
  result?: Record<string, unknown>;
  usage?: AgentUsage;
  error?: string;
  [key: string]: unknown;
}

export interface GitContext {
  enabled: boolean;
  branch?: string;
  checkpoint?: string;
  loop_branch?: string;
  pre_loop_commit?: string;
}

export interface AttemptsSettings {
  max_per_section: number;
}
