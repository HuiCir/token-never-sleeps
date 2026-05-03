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

  tns doctor --config /abs/path/to/project/tns_config.json
      Run preflight and environment diagnostics before a long run.

  tns trace --config /abs/path/to/project/tns_config.json
      Read recent activity events and validator outcomes.

  tns recover --config /abs/path/to/project/tns_config.json
      Clear stale runtime/lock state and recover interrupted sections.

  tns compile --config /abs/path/to/project/tns_config.json
      Compile task.md and config into a deterministic orchestration program.

  tns start --config /abs/path/to/project/tns_config.json
      Use managed tmux when configured and available; otherwise run directly.

  tns run --config /abs/path/to/project/tns_config.json --once
      Run one loop directly. Good for manual stepping and debugging.

  tns approve --config /abs/path/to/project/tns_config.json --tag restricted-step
      Grant one named escalated permission tag after user review.

  tns revoke --config /abs/path/to/project/tns_config.json --tag restricted-step
      Remove a previously granted escalated permission tag.

  tns run-tmux --config /abs/path/to/project/tns_config.json
      Explicit tmux mode. Requires tmux.

  tns skill install pdf --config /abs/path/to/project/tns_config.json --source /path/to/skillbase
      Bind a skill source, install a named skill into a runner injection profile, and persist it.

  tns skills --action doctor --source /path/to/skillbase
      Inspect skillbase/plugin skill sources without modifying config.

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
       tns approve --config /abs/path/to/project/tns_config.json --tag restricted-step

Help topics:
  tns help init
  tns help run
  tns help config
  tns help permissions
  tns help exploration
  tns help policy
  tns help compile
  tns help skills
  tns help status
  tns help tmux
  tns help btw
  tns help doctor
`,
  init: `
TNS init

New workspace:
  tns init --workspace /abs/path/to/project
  tns init --workspace /abs/path/to/project --template novel-writing

Creates:
  task.md
  tns_config.json
  .tns/

Options:
  --template blank|novel-writing
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
  - run acquires named resource locks for workspace, runner, and state.
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

  preflight is optional:
    required_files
    required_directories

  validators is optional:
    staged checks at preflight, pre_step, post_step, post_run

  command_bridge is optional:
    command_sets
    hooks

  policy is optional:
    preflight_failure
    command_failure
    outside_workspace_violation
    validator_failure by stage

  outputs is optional:
    write_section_outputs

  externals is optional:
    tools
    skills
    mcp

  execution is optional:
    long_running
    temporary
    verifier

  injections is optional:
    profiles
    rules

  skillbases is optional:
    use_default_sources
    sources

  thread is optional:
    Top-level user switch. Set thread: 2 to request bounded parallel planning
    when program.threads is not set.

  program is optional:
    entry
    context
    states
    max_steps
    threads
    parallel

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

  command_bridge.command_sets
      Predeclared runner-side commands that TNS executes directly, outside Claude.

  validators
      Declarative staged checks so result quality is enforced by the runner.

  execution.verifier
      Short-cycle validation node settings. Use a bounded max_runtime_seconds
      and readonly/audit-oriented skills so verifier remains independent.

  injections.rules
      Stage-local skill injection. Keep executor domain/action skills separate
      from verifier audit skills unless you explicitly want shared context.

  skillbases.sources
      User-provided skill libraries. Each source has path, optional id, kind
      auto|skillbase|plugin|skills_dir, enabled, and priority. Skills can be
      injected by name after they resolve from these sources.

  program
      Explicit orchestration program used by compile and the runner.
`,
  skills: `
TNS skills

Inspect skill libraries without installing or modifying them:
  tns skills --action doctor
  tns skills --action list
  tns skills --action resolve --name pdf
  tns skills --action match --text "extract tables from a PDF report"

Manage configured sources and installed skill bindings:
  tns skill source-add --config /abs/path/to/tns_config.json --source /path/to/skillbase
  tns skill source-list --config /abs/path/to/tns_config.json
  tns skill install pdf --config /abs/path/to/tns_config.json
  tns skill install pdf --config /abs/path/to/tns_config.json --source /path/to/skillbase
  tns skill uninstall pdf --config /abs/path/to/tns_config.json

Install behavior:
  - source-add persists skillbases.sources in tns_config.json.
  - install resolves the named skill from configured/default/CLI sources.
  - install writes the skill into injections.profiles.executor_task.skills by default.
  - use --mode verifier to install into verifier_audit, or --profile NAME for an explicit profile.
  - install also records the skill in externals.skills for compile-time inventory.

With explicit sources:
  tns skills --action doctor --source /root/codex/skillbase --source /root/.codex/.tmp/plugins
  tns skills --action resolve --name pdf --source /path/to/skillbase

Config:
  skillbases.use_default_sources defaults to true.
  skillbases.sources accepts user plugin libraries, extracted skillbases, or
  direct skills directories.

Supported source kinds:
  skillbase   A directory with skills/ and optional index.json.
  plugin      A plugin library containing nested plugin skills.
  skills_dir  A direct directory of skill folders.
  auto        Detect the shape from files on disk.

Injection:
  injections.profiles.*.skills can reference names such as pdf. TNS resolves
  the name at runtime, creates a per-agent plugin sandbox, records the selected
  source path, and then garbage-collects the sandbox after the agent call.

Selection modes:
  skillbases.selection.mode defaults to explicit.
  explicit uses only config/program skills and task.md import lines.
  auto can match section text against configured skillbases.
  A section can override with:
    skills: auto
    skills: explicit
    skills: off

Separation:
  TNS package-local skills are not part of the external user skillbase. They are
  only resolved for internal compile-time tns-* skills. Executor/verifier skill
  imports resolve from configured user skillbases or explicit external paths.
`,
  compile: `
TNS compile

Compile the current task and config into a deterministic orchestration program:
  tns compile --config /abs/path/to/tns_config.json
  tns compile --config /abs/path/to/tns_config.json --synthesize
  tns compile --config /abs/path/to/tns_config.json --synthesize --apply

Output:
  .tns/compiled/program.json
  .tns/compiled/compiler-review.json    when synthesis is enabled

The compiled program captures:
  - workspace and lifecycle
  - section graph from task.md
  - bridge files and runtime state files
  - permissions, validators, command bridge, policy
  - declared and inferred external tools/skills/MCP requirements

Synthesis mode:
  - runs the dedicated compiler agent
  - returns a structured patch for preflight, permissions, validators, command hooks, policy, and externals
  - --apply merges that patch into tns_config.json and recompiles

Use this when:
  - you want Claude to read a stable program contract instead of inferring orchestration ad hoc
  - you want task.md converted into machine-readable runtime structure
  - you need an explicit inventory of external dependencies

Recommendation:
  Run compile after major task/config changes, then let executor/verifier read the compiled program.
`,
  policy: `
TNS policy and precompiled command sets

TNS now has a runner-side policy engine and command bridge.

Precompiled command sets:
  "command_bridge": {
    "command_sets": {
      "manifest-check": {
        "command": ["node", "scripts/check_manifest.mjs"],
        "cwd": ".",
        "timeout_seconds": 120
      }
    },
    "hooks": [
      { "stage": "post_step", "match_step": "executor", "command_sets": ["manifest-check"] }
    ]
  }

Policy behavior:
  "policy": {
    "preflight_failure": { "action": "block_section", "review_prefix": "Preflight failed" },
    "command_failure": { "action": "mark_needs_fix", "review_prefix": "Command hook failed" },
    "outside_workspace_violation": { "action": "block_section" },
    "validator_failure": {
      "pre_step": { "action": "mark_needs_fix" },
      "post_step": { "action": "mark_needs_fix" },
      "post_run": { "action": "mark_needs_fix" }
    }
  }

Meaning:
  - command sets are trusted, predeclared commands executed by TNS itself
  - validators inspect outputs at fixed stages
  - policy decides whether failures freeze, block, mark needs_fix, or fail the run

Recommended diagnostics:
  tns doctor --config /abs/path/to/tns_config.json
  tns trace --config /abs/path/to/tns_config.json
`,
  doctor: `
TNS doctor and recover

Diagnostics:
  tns doctor --config /abs/path/to/tns_config.json

Recovery:
  tns recover --config /abs/path/to/tns_config.json
  tns recover --config /abs/path/to/tns_config.json --force

Trace:
  tns trace --config /abs/path/to/tns_config.json
  tns trace --config /abs/path/to/tns_config.json --section sec-002

doctor runs:
  - config load
  - binary detection
  - tmux probe
  - workspace preflight

recover clears:
  - stale runtime state
  - stale resource locks
  - lingering in_progress sections
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
      "restricted_step": {
        "permission_mode": "acceptEdits",
        "allowed_bash_commands": ["pwd", "ls", "cat", "sed", "rg", "find", "node"],
        "requires_approval": "restricted-step",
        "workspace_only": true
      }
    },
    "section_profiles": [
      { "match_title": "Restricted step", "profile": "restricted_step" }
    ]
  }

Runtime behavior:
  1. TNS resolves a permission profile per section step.
  2. Safe tools in that profile are auto-approved through Claude allowedTools.
  3. If the profile requires approval and the tag is missing, TNS freezes and records a pending approval request.
  4. The user reviews the request and runs:
       tns approve --config /abs/path/to/tns_config.json --tag restricted-step
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
  - named resource locks
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
