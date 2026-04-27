# Token Never Sleeps

`token-never-sleeps` is a clean TypeScript distribution of the TNS agent external orchestration loop.

It keeps the core local runner behavior:

- `tns init` creates a runnable workspace
- `tns run` executes one direct local loop
- `tns start` chooses tmux or direct mode
- `tns status` shows tracked section state
- `tns plan-import` converts a markdown plan into tracked sections

What this package intentionally leaves out:

- Python entrypoints
- Claude plugin skills and hook wrappers
- bundled website content
- heavyweight demo outputs and media artifacts
- remote notification glue that is not part of the local runner core

## Install

```bash
npm install -g token-never-sleeps
```

## Requirements

- Node.js 22+
- `claude` CLI available in `PATH`
- optional: `tmux` if you want managed runner mode

## Quickstart

Create a blank workspace:

```bash
tns init --workspace ./my-task
```

Create a template workspace:

```bash
tns init --workspace ./novel-project --template novel-writing
tns init --workspace ./fsm-case --template fsm-control-flow
```

Then run:

```bash
cd ./my-task
tns compile --config ./tns_config.json
tns status --config ./tns_config.json
tns btw --config ./tns_config.json
tns run --config ./tns_config.json --once
```

FSM validation workspace:

```bash
tns init --workspace ./fsm-case --template fsm-control-flow
cd ./fsm-case
tns compile --config ./tns_config.json
tns simulate --config ./tns_config.json
```

## Deterministic compilation

TNS can compile `task.md` and `tns_config.json` into a deterministic orchestration program:

```bash
tns compile --config ./tns_config.json
tns compile --config ./tns_config.json --synthesize
tns compile --config ./tns_config.json --synthesize --apply
```

This writes:

- `.tns/compiled/program.json`
- `.tns/compiled/compiler-review.json` when synthesis is enabled

The compiled program makes these contracts explicit:

- task sections and required inputs
- bridge files and state files
- lifecycle and watchdog settings
- permission profiles and approval tags
- validators and runner-side command hooks
- declared external tools, skills, and MCP requirements

The runner will tell Claude to read the compiled program when it exists, so orchestration details stop living only in prompt inference.

Synthesis mode runs the dedicated compiler agent and produces a structured patch for:

- preflight
- permissions
- validators
- runner-side command hooks
- policy
- external tools / skills / MCP declarations

`--apply` merges that patch back into `tns_config.json` and recompiles.

## FSM programs

TNS can carry an explicit finite-state program in `config.program`.

It supports:

- `task`, `decision`, `loop`, `terminal` states
- deterministic transitions with conditions
- instruction ops: `set`, `inc`, `dec`, `append`, `emit`, `if`, `while`

Use:

```bash
tns simulate --config ./tns_config.json
tns simulate --config ./tns_config.json --set approved=true --compact
```

## Stage permissions

`token-never-sleeps` can auto-approve safe command families for Claude inside a workspace,
and stop for explicit user approval when a section needs stronger permissions.

Typical flow:

```bash
tns run --config ./tns_config.json --once
tns btw --config ./tns_config.json
tns approve --config ./tns_config.json --tag restricted-step --note "approved by operator"
tns run --config ./tns_config.json --once
```

Key points:

- each section step resolves a permission profile
- safe command families are passed through Claude `--allowedTools`
- escalated profiles can require an approval tag such as `restricted-step`
- missing approvals freeze the workspace and create `.tns/approvals.json`
- executor `files_touched` are audited and rejected if they point outside the workspace

See also:

```bash
tns help permissions
```

## Exploration xmode (beta)

`token-never-sleeps` can optionally run one post-completion exploration pass after
all tracked sections are done.

Use it when you want:

- one extra detail and robustness review
- small concrete refinements after the main task is already complete
- optional follow-up work captured into `taskx.md`

Example config:

```json
{
  "exploration": {
    "enabled": true,
    "allow_taskx": true,
    "taskx_filename": "taskx.md",
    "max_rounds_per_window": 1,
    "agent": "tns-executor"
  }
}
```

If the exploration pass finds explicit new requirements, it can create `taskx.md`,
TNS will import those sections, and the runner will continue with them.

## Long-running Claude sessions

`token-never-sleeps` keeps a runtime heartbeat while one Claude agent call is still in flight. If a single Claude follow session runs too long, the watchdog terminates that one call, marks the section as retryable, and lets the next loop continue from saved state instead of blocking the whole runner indefinitely.

Default monitor settings:

```json
{
  "monitor": {
    "heartbeat_seconds": 30,
    "max_agent_runtime_seconds": 1800,
    "kill_grace_seconds": 15
  }
}
```

Use `tns btw --config ./tns_config.json` to inspect:

- current runner heartbeat
- active section and step
- active Claude agent and child pid
- current agent deadline
- next wake time after freezes or sleeps

`status` and `btw` also expose named resource locks under `.tns/locks/`, so compile/run/control flows can coordinate without corrupting shared state.

## Templates

Available templates:

- `blank`
- `novel-writing`
- `fsm-control-flow`

Templates live under `templates/` inside the package and are copied into the target workspace by `tns init`.

## Commands

```bash
tns help
tns help init
tns help compile
tns help fsm
tns help run
tns help config
tns help permissions
tns help exploration
tns help tmux
```

## Package Layout

```text
agents/            Claude agent definitions used by the runner
.claude-plugin/    minimal plugin metadata so claude can load the local agents
dist/              compiled CLI output
skills/            reusable skills, including task-to-program compilation guidance
templates/         workspace templates copied by tns init
```

## Scope

This distribution is meant to be a clean npm runner. It does not try to preserve every historical feature from the mixed plugin repository. If a feature is not implemented in TypeScript here, it is intentionally out of scope for this package.
