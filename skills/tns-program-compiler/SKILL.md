---
name: tns-program-compiler
description: Compile a TNS task.md and tns_config.json into a deterministic orchestration program before long-running execution. Use when Claude should stop inferring workflow ad hoc and instead produce or update explicit contracts for inputs, bridge files, permissions, lifecycle, workspace boundaries, validators, command hooks, and required external tools, skills, or MCP servers.
---

# TNS Program Compiler

Use this skill when the task is to turn a free-form TNS workspace into a deterministic runtime contract.

## Goal

Convert `task.md` plus `tns_config.json` into explicit orchestration artifacts that the runner and later Claude sessions can follow without re-deriving the system design.

Primary output:
- `.tns/compiled/program.json`

If `program.json` is missing or stale, run:

```bash
tns compile --config /abs/path/to/tns_config.json
```

## Required reading

Read these first:
- `task.md`
- `tns_config.json`
- `.tns/compiled/program.json` if it already exists

Read `.tns/handoff.md` and `.tns/sections.json` when the workspace has already been running.

## What must become explicit

The compiled program must contain or imply all of these:
- inputs and required files/directories
- section graph from `task.md`
- bridge files: handoff, sections, reviews, activity, artifacts, approvals, runtime, diagnostics
- lifecycle: refresh window, runtime heartbeat, watchdog, tmux/direct mode, exploration mode
- workspace boundary rules
- permission profiles and approval tags
- validators by stage
- runner-side command hooks and command sets
- explicit FSM program when branching or looping behavior matters
- explicit parallel/thread contract when `thread` or `threads` is greater than 1
- executor tiering when temporary workers are needed for resource control
- declared externals: tools, skills, MCP servers/resources

If any of the above is only implicit, tighten the config or update the compiled program path before continuing.

## Operating rules

1. Prefer deterministic runner-side logic over soft prompt guidance.
2. Prefer `command_bridge.command_sets` over ad hoc shell snippets inside Claude.
3. Prefer staged validators over informal “remember to check”.
4. Prefer `config.externals` declarations over hidden assumptions about tools, skills, or MCP.
5. Do not silently invent external dependencies. If they are required, declare them.
6. If multi-threading is enabled, keep thread count bounded and make cooperation explicit with FSM state metadata and thread control instructions.
7. Prefer long-running executor ownership of durable state and temporary executor ownership of isolated short-lived work.

## Compilation workflow

1. Compile:
   - run `tns compile --config ...`
2. Inspect the output:
   - check `inputs`
   - check `bridge`
   - check `orchestration.permissions`
   - check `orchestration.validators`
   - check `orchestration.command_bridge`
   - check `externals`
3. Tighten missing contracts:
   - add `preflight.required_files` and `required_directories`
   - add `validators`
   - add `command_bridge.command_sets`
   - add `policy`
   - add `externals.tools / skills / mcp`
   - add `execution.long_running / execution.temporary`
   - add `program` when task flow should be explicit finite-state orchestration
4. Re-compile after config changes.

## When to read references

- For field expectations and output meaning, read [references/program-schema.md](references/program-schema.md).
- For external dependency declaration, read [references/externals.md](references/externals.md).

## Completion standard

The workspace is properly compiled only when:
- `program.json` exists
- external dependencies are declared, not implied
- the command bridge covers deterministic shell work
- staged validators reflect actual acceptance boundaries
- policy behavior is explicit for failure cases
- multi-thread mode has a visible `parallel_plan`
- temporary executors have a handback/GC contract instead of durable state ownership
