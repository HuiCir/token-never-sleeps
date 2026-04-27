const HELP: Record<string, string> = {
  main: `
TNS

TNS runs long work from task.md as tracked sections. It keeps .tns state files so runs can resume after interruptions.

Common commands:
  tns init --workspace /abs/path/to/project
      Create a runnable workspace from a blank or named template.

  tns status --config /abs/path/to/project/tns_config.json
      Show mutable runner state, counts, freeze, approvals, artifacts, and tmux.

  tns btw --config /abs/path/to/project/tns_config.json
      Read a live, read-only snapshot during long runs without touching runner state.

  tns start --config /abs/path/to/project/tns_config.json
      Use managed tmux when configured and available; otherwise run directly.

  tns run --config /abs/path/to/project/tns_config.json --once
      Run one loop directly. Good for manual stepping and debugging.

  tns approve --config /abs/path/to/project/tns_config.json --tag media-assets
      Grant one named escalated permission tag after user review.

  tns revoke --config /abs/path/to/project/tns_config.json --tag media-assets
      Remove a previously granted escalated permission tag.

  tns run-tmux --config /abs/path/to/project/tns_config.json
      Explicit tmux mode. Requires tmux.

Typical flows:
  1. Create a workspace:
       tns init --workspace /abs/path/to/project --template novel-writing

  2. Inspect before running:
       tns status --config /abs/path/to/project/tns_config.json

  3. Manual loop:
       tns run --config /abs/path/to/project/tns_config.json --once

  4. Long unattended loop:
       tns start --config /abs/path/to/project/tns_config.json

  5. Read-only monitoring during long runs:
       tns btw --config /abs/path/to/project/tns_config.json

  6. Approve a gated stage:
       tns approve --config /abs/path/to/project/tns_config.json --tag media-assets

Help topics:
  tns help init
  tns help run
  tns help config
  tns help permissions
  tns help exploration
  tns help status
  tns help tmux
  tns help btw
`,
  init: `
TNS init

New workspace:
  tns init --workspace /abs/path/to/project
  tns init --workspace /abs/path/to/project --template novel-writing
  tns init --workspace /abs/path/to/project --template audiobook-video

Creates:
  task.md
  tns_config.json
  .tns/

Options:
  --template blank|novel-writing|audiobook-video
                   Copy a built-in workspace template.
  --runner auto      Enable managed tmux only when tmux is installed.
  --runner direct    Always use direct mode.
  --runner tmux      Require tmux.
  --force            Overwrite existing task/config.

Existing config:
  tns init --config /abs/path/to/tns_config.json

Notes:
  - init creates task.md, tns_config.json, and .tns state files.
  - template support files are copied into the workspace.
  - runner auto selects direct mode when tmux is unavailable.
`,
  run: `
TNS run modes

Recommended:
  tns start --config /abs/path/to/tns_config.json

Portable direct mode:
  tns run --config /abs/path/to/tns_config.json

Managed tmux mode:
  tns run-tmux --config /abs/path/to/tns_config.json

Live snapshot without mutating state:
  tns btw --config /abs/path/to/tns_config.json

Long-running agent guardrail:
  monitor.heartbeat_seconds updates runtime while Claude is still running.
  monitor.max_agent_runtime_seconds bounds one Claude follow session so the loop can retry.

Common patterns:
  Manual single pass:
    tns run --config /abs/path/to/tns_config.json --once

  Direct long loop:
    tns run --config /abs/path/to/tns_config.json

  Managed long loop:
    tns start --config /abs/path/to/tns_config.json

Important:
  - run acquires the workspace lock.
  - btw does not acquire the workspace lock.
  - frozen workspaces do not advance until freeze expires or is cleared.
`,
  config: `
TNS config

Required:
  workspace

Defaults:
  product_doc defaults to workspace/task.md.
  tmux is optional.
  monitor is optional:
    heartbeat_seconds
    max_agent_runtime_seconds
    kill_grace_seconds

  permissions is optional:
    default_profile
    profiles
    section_profiles

  exploration is optional:
    enabled
    allow_taskx
    taskx_filename
    max_rounds_per_window
    agent

Important fields:
  refresh_hours / refresh_minutes / refresh_seconds
      Define the scheduling window metadata.

  success_interval_seconds / idle_interval_seconds
      Control loop polling speed in direct or tmux runner modes.

  monitor.heartbeat_seconds
      Runtime heartbeat frequency while Claude is still running.
`,
  exploration: `
TNS exploration mode

Exploration mode is optional and disabled by default.

Purpose:
  After all tracked sections are complete, TNS can run one additional review pass
  to improve detail, consistency, and robustness. If it finds explicit new
  follow-up requirements, it may create taskx.md and import those sections back
  into the active queue.

Config shape:
  "exploration": {
    "enabled": false,
    "allow_taskx": true,
    "taskx_filename": "taskx.md",
    "max_rounds_per_window": 1,
    "agent": "tns-executor"
  }

Behavior:
  1. Main task sections finish.
  2. TNS runs one post-completion review pass.
  3. Small concrete refinements may be applied directly.
  4. If explicit, actionable new requirements are found, TNS creates taskx.md.
  5. taskx.md sections are imported and the runner continues with them.

Guards:
  - default is disabled
  - max_rounds_per_window prevents infinite self-expansion
  - taskx creation is optional
  - workspace path audit still applies to files_touched

Recommended start:
  tns run --config /abs/path/to/tns_config.json --once
  tns btw --config /abs/path/to/tns_config.json

Watch state:
  .tns/exploration.json
`,
  permissions: `
TNS permissions

TNS can auto-approve safe command families and freeze for explicit user approval
when a section needs stronger permissions.

Config shape:
  "permissions": {
    "default_profile": "standard",
    "profiles": {
      "standard": {
        "permission_mode": "acceptEdits",
        "allowed_bash_commands": ["pwd", "ls", "cat", "sed", "rg", "find", "git", "node"],
        "workspace_only": true
      },
      "media_generation": {
        "permission_mode": "acceptEdits",
        "allowed_bash_commands": ["pwd", "ls", "cat", "sed", "rg", "find", "node", "mmx", "ffmpeg", "ffprobe"],
        "requires_approval": "media-assets",
        "workspace_only": true
      }
    },
    "section_profiles": [
      { "match_title": "Media generation", "profile": "media_generation" }
    ]
  }

Runtime behavior:
  1. TNS resolves a permission profile per section step.
  2. Safe tools in that profile are auto-approved through Claude allowedTools.
  3. If the profile requires approval and the tag is missing, TNS freezes and records a pending approval request.
  4. The user reviews the request and runs:
       tns approve --config /abs/path/to/tns_config.json --tag media-assets
  5. The next run continues with that approval in place.

Read-only inspection:
  tns btw --config /abs/path/to/tns_config.json

Approval state is stored in:
  .tns/approvals.json

TNS also audits executor-reported files_touched and rejects paths outside the
configured workspace.

Operational notes:
  - approve clears matching approval_required freezes.
  - revoke does not stop an already running process; it affects later runs.
  - workspace_only is a policy and audit signal, not a kernel sandbox.
`,
  status: `
TNS status and monitoring

Mutable status:
  tns status --config /abs/path/to/tns_config.json

Read-only live status:
  tns btw --config /abs/path/to/tns_config.json

Use status when you want:
  - section counts
  - freeze state
  - approval state
  - artifacts index
  - tmux and runtime snapshots

Use btw during long runs when you do not want to touch runner state.

Watch for:
  approvals.pending
      stages waiting for explicit user approval

  runner.heartbeat_at
      last runner heartbeat

  runner.agent_deadline_at
      watchdog deadline for the active Claude call

  next_wake_at
      next scheduled wake after freeze or sleep
`,
  tmux: `
TNS tmux behavior

tmux is optional. Use direct mode on Windows or any system where tmux is missing.

Recommended:
  tns start --config /abs/path/to/tns_config.json

Status reports available=false and fallback=direct when tmux is not installed.

Runner notes:
  - start prefers managed tmux when enabled and actually usable.
  - run-tmux fails fast if tmux is requested but unavailable.
  - direct mode remains the portable fallback.
`,
  btw: `
TNS btw

Read-only snapshot for long-running work:
  tns btw --config /abs/path/to/tns_config.json

Optional limits:
  --events 12
  --reviews 5

This command does not acquire the workspace lock, does not rebuild artifacts,
and does not rewrite freeze, tmux, or runtime state. It only reads current .tns
files and prints the latest snapshot.

Typical use:
  tns btw --config /abs/path/to/tns_config.json --events 12 --reviews 5
`,
};

export async function cmdHelp(args: { topic?: string }): Promise<void> {
  const topic = args.topic && args.topic in HELP ? args.topic : "main";
  console.log(HELP[topic].trim());
}
