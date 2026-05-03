# Token Never Sleeps

`token-never-sleeps` is a clean TypeScript distribution of the TNS agent external orchestration loop.

It keeps the core local runner behavior:

- `tns init` creates a runnable workspace
- `tns run` executes one direct local loop
- `tns start` chooses tmux or direct mode
- `tns status` shows tracked section state
- `tns plan-import` converts a markdown plan into tracked sections
- `tns compile` emits a deterministic orchestration program, including bounded parallel plans
- `tns skill` manages configured skill sources and installed skill bindings
- `tns skills` inspects local skillbases and resolves stage-local skill imports without modifying config

What this package intentionally leaves out:

- Python entrypoints
- bundled website content
- heavyweight generated outputs and media artifacts
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
```

Then run the real orchestration loop:

```bash
cd ./my-task
tns compile --config ./tns_config.json
tns status --config ./tns_config.json
tns doctor --config ./tns_config.json
tns run --config ./tns_config.json --once
```

For long-running work, use the managed runner and inspect it without mutating state:

```bash
tns start --config ./tns_config.json
tns btw --config ./tns_config.json
tns trace --config ./tns_config.json
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
- thread count and bounded parallel planning hints
- permission profiles and approval tags
- validators and runner-side command hooks
- declared external tools, skills, and MCP requirements
- state-level skill imports such as `import pdf`

For task documents without an explicit `config.program`, compile also derives a
conservative section dependency graph. Use `Depends on: <section title or id>`
inside a section, or reference a backticked artifact path created by an upstream
section, to materialize `parallel.depends_on` in the generated program and
bounded `parallel_plan`.

At run time, TNS also checks whether `task.md` and `.tns/sections.json` have
drifted from the compiled contract. It can refresh derived compiled programs and
section state automatically, and records the latest retry/recompile/block
decision in `.tns/diagnostics.json`.

The runner reads the compiled program when it exists, so orchestration details stop living only in prompt inference. For example, a section body containing:

```text
import pdf
```

is compiled into the matching state as:

```json
{
  "parallel": {
    "skills": ["pdf"]
  }
}
```

At runtime, the executor resolves and injects that skill for the section.
Synthesis mode runs the dedicated compiler agent and produces a structured patch for:

- preflight
- permissions
- validators
- runner-side command hooks
- policy
- external tools / skills / MCP declarations

`--apply` merges that patch back into `tns_config.json` and recompiles.

## Orchestration Programs

TNS can carry an explicit orchestration program in `config.program`.

It supports:

- `task`, `decision`, `loop`, `terminal` states
- deterministic transitions with conditions
- instruction ops: `set`, `inc`, `dec`, `append`, `emit`, `if`, `while`
- thread-control ops: `thread_suspend`, `thread_resume`, `thread_interrupt`, `thread_wait`
- state-level parallel hints under `parallel`

Compile materializes that program and writes the runner-visible contract to
`.tns/compiled/program.json`:

```bash
tns compile --config ./tns_config.json
tns status --config ./tns_config.json
tns run --config ./tns_config.json --once
```

## Bounded Parallel Planning

Set `thread` or `threads` to request bounded parallel orchestration:

```json
{
  "thread": 2,
  "program": {
    "threads": 2,
    "parallel": {
      "mode": "auto",
      "max_threads": 2
    }
  }
}
```

The current planning layer keeps heavy Claude parallel plans bounded to two threads on this machine profile. The compiler emits a `parallel_plan` with batches, resources, dependencies, and thread controls. The standard runner executes the next ready parallel batch with `Promise.allSettled`; singleton batches continue through the conservative one-section path. State-level hints include:

- `parallel.thread`
- `parallel.resource`
- `parallel.depends_on`
- `parallel.exclusive`
- `parallel.starts_suspended`
- `parallel.executor_class`
- `parallel.skills`
- `parallel.verifier_skills`
- `parallel.workspace`
- `parallel.merge_policy`

Use `tns trace --config ./tns_config.json` to inspect `parallel_batch_start`,
`agent_start`, `agent_end`, and `parallel_batch_end` events from the real run.

## Skillbases

TNS supports user-provided skill libraries for executor and verifier injection. A source can be an extracted skillbase, a plugin library, or a direct directory of skill folders:

```json
{
  "skillbases": {
    "use_default_sources": false,
    "sources": [
      {
        "id": "local-skillbase",
        "path": "/abs/path/to/skillbase",
        "kind": "skillbase",
        "priority": 0
      }
    ]
  }
}
```

Inspect and resolve skills:

```bash
tns skills --action doctor --source /abs/path/to/skillbase
tns skills --action list --source /abs/path/to/skillbase
tns skills --action resolve --name pdf --source /abs/path/to/skillbase
tns skills --action match --text "extract tables from a PDF report" --source /abs/path/to/skillbase
```

Persist a skill source and install a skill into the runner config:

```bash
tns skill source-add --config ./tns_config.json --source /abs/path/to/skillbase
tns skill source-list --config ./tns_config.json
tns skill install pdf --config ./tns_config.json
```

Install can bind a source and skill in one command:

```bash
tns skill install pdf --config ./tns_config.json --source /abs/path/to/skillbase
```

By default, `install` writes the resolved skill into
`injections.profiles.executor_task.skills` and records it in `externals.skills`.
Use `--mode verifier` to install into `verifier_audit`, or `--profile NAME` to
target a custom injection profile.

Skill injection is stage-local:

- compiler-stage TNS internal skills are resolved from the package-local `skills/` directory
- executor and verifier imports resolve from configured user skillbases or explicit external skill paths
- verifier skills do not inherit executor skills unless you explicitly configure them

This keeps TNS internal skills separate from the user’s external skillbase while still allowing natural-language imports such as `import pdf`.

Skill selection is controlled by the skill management layer, not by the compiler agent:

- `skillbases.selection.mode: "explicit"` uses only manually planned skills from config, program state, or `task.md` import lines
- `skillbases.selection.mode: "auto"` matches each section against the configured skillbase
- a section can override the config with `skills: auto`, `skills: explicit`, or `skills: off`

Example automatic matching:

```json
{
  "skillbases": {
    "use_default_sources": false,
    "sources": [
      { "id": "local-skillbase", "path": "/abs/path/to/skillbase", "kind": "skillbase", "priority": 0 }
    ],
    "selection": {
      "mode": "auto",
      "max_matches_per_section": 2,
      "min_score": 0.22,
      "verifier_mode": "none"
    }
  }
}
```

With `mode: "explicit"`, SkillsBench-style preset skills map naturally to explicit `import pdf` lines or `program.states[].parallel.skills`. With `mode: "auto"`, TNS searches the configured base and records `auto_skills` plus match scores in `.tns/injection-events.jsonl`.

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

Templates live under `templates/` inside the package and are copied into the target workspace by `tns init`.

## Commands

```bash
tns help
tns help init
tns help compile
tns help skills
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
