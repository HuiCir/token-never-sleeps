# Token Never Sleeps

Token Never Sleeps is a Claude plugin for long-running work from a TaskList `task.md`.

Default behavior:

- reads `workspace/task.md`
- auto-initializes on first `/tns-start run`
- uses a 5 hour refresh window
- keeps git enabled
- rolls back to the latest clean state if Claude hits a usage-limit style error

## Quickstart

### 1. Plugin Install

Install it directly as a Claude plugin

```bash
claude plugin marketplace add https://github.com/HuiCir/token-never-sleeps
claude plugin install token-never-sleeps@token-never-sleeps
claude
```

Get it from GitHub and load it locally

```bash
git clone https://github.com/HuiCir/token-never-sleeps.git
cd token-never-sleeps
./scripts/install-local.sh
claude --plugin-dir ~/.claude/plugins/local/token-never-sleeps
```

`install-local.sh` now copies the plugin into `~/.claude/plugins/local/token-never-sleeps`
and renders hook/skill command paths during install. The installed plugin does not rely on
`${CLAUDE_PLUGIN_ROOT}` being present on the machine.

Install Verification

```bash
claude plugin validate ~/.claude/plugins/local/token-never-sleeps
```

### 2. In your workspace create two files

`tns_config.json`

Full config template: [examples/tns_config.json](examples/tns_config.json).
The template includes required fields, defaulted optional fields, and advanced beta options such as `tmux`, quota policies, notifications, and git controls.

```json
{
  "workspace": "/absolute/path/to/project"
}
```

`task.md`

```md
# Task

## Section 1
Task 1 ...

## Section 2
Task 2 ...
```

### 3. Check status inside Claude

```text
/tns-status --config tns_config.json
```

### 4. Start TNS inside Claude

```text
/tns-start run --config tns_config.json
```

If you want the runner itself to stay alive inside `tmux`, enable `tmux.enabled` and
`tmux.manage_runner`, then start it the same way inside Claude:

```text
/tns-start run-tmux --config tns_config.json
```

## Tmux Runner Usage

Recommended config shape:

```json
{
  "tmux": {
    "enabled": true,
    "auto_create": true,
    "session_name": "my-project-tns",
    "window_name": "tns",
    "manage_runner": true,
    "runner_window_name": "tns-runner"
  }
}
```

Recommended flow:

1. Start the managed runner inside Claude:

```text
/tns-start run-tmux --config /abs/path/to/tns_config.json
```

2. Recreate the runner window inside Claude if needed:

```text
/tns-start run-tmux --config /abs/path/to/tns_config.json --restart
```

3. Inspect state inside Claude:

```text
/tns-status --config /abs/path/to/tns_config.json
```

4. Attach to the tmux session from a shell only when you need interactive inspection:

```bash
tmux attach -t my-project-tns
```

The direct `python3 scripts/tns_runner.py ...` commands are still valid for local debugging,
but normal plugin use should go through `/tns-start` and `/tns-status`.

What tmux integration gives you:

- a durable session even if the launching shell disconnects
- a dedicated runner window for the polling loop
- status output that includes runner panes, runner log path, and recent hook feedback

## Claude-Code-Remote Integration

## Claude-Code-Remote Integration

TNS can integrate with a local Claude-Code-Remote checkout and send remote reports for:

- task start
- workflow step progress
- loop completion

Enable `notifications.claude_code_remote.enabled`, point `root` to your
Claude-Code-Remote repository, and keep its own `.env` / channel config working.

Recommended config shape:

```json
{
  "notifications": {
    "claude_code_remote": {
      "enabled": true,
      "root": "/absolute/path/to/Claude-Code-Remote",
      "report_task_start": true,
      "report_step_progress": true,
      "report_task_complete": true,
      "node_bin": "node"
    }
  }
}
```

Recommended setup:

1. Keep credentials in `Claude-Code-Remote/.env` or its local channel config.
2. Do not put SMTP passwords, IMAP passwords, or inbox targets in `tns_config.json`.
3. Let TNS reference the local Claude-Code-Remote checkout only by filesystem path.
4. Verify Claude-Code-Remote can already send notifications on its own before wiring TNS to it.

TNS sends:

- `waiting`-style remote reports for task start and intermediate step updates
- `completed`-style remote reports when a loop finishes with verifier pass

This keeps Telegram / Email / LINE remote control working while letting TNS provide staged progress updates.

Operational note:

- `scripts/ccremote_notify.js` loads the target Claude-Code-Remote checkout and sends through whichever channels are enabled there.
- Local desktop notifications can fail without breaking email / Telegram / LINE delivery.
- The remote bridge is intentionally credential-free on the TNS side. Authentication stays in Claude-Code-Remote local config.


## Workflow / Multi-Agent

TNS now supports a configurable `workflow.agents` graph instead of only the fixed
executor/verifier pair.

- Each workflow node declares an `id`, `agent`, `schema`, and `transitions`.
- Transitions can branch on payload fields such as `status`, `outcome`, or any custom JSON field.
- This lets you model loops like `executor -> verifier -> executor`, or add extra nodes such as planner, reviewer, triager, or release-check.

The default workflow remains the same logical loop:

- `executor`
- if blocked: mark section `blocked`
- if not clean or not ready: mark section `pending`
- otherwise jump to `verifier`
- `verifier`
- if pass: mark section `done`
- else: mark section `needs_fix`
