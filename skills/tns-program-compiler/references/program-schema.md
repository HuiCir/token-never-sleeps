# Compiled Program Schema

The compiled output is written to:

- `.tns/compiled/program.json`

Expected top-level shape:

```json
{
  "version": 1,
  "compiled_at": "ISO-8601",
  "workspace": {},
  "lifecycle": {},
  "inputs": {},
  "bridge": {},
  "orchestration": {},
  "externals": {}
}
```

## workspace

- `root`
- `product_doc`
- `state_dir`
- `task_digest`

## lifecycle

- refresh window fields
- monitor/watchdog settings
- tmux settings
- exploration settings
- parallel settings:
  - `configured_threads`
  - `mode`
  - `max_threads`
- execution settings:
  - `long_running`
  - `temporary`
  - `verifier`

## inputs

- `preflight`
- parsed task sections
- `program`
- `parallel_plan`

## bridge

Paths to state-bearing files that move information between runs:
- `handoff_file`
- `sections_file`
- `reviews_file`
- `activity_file`
- `artifacts_file`
- `approvals_file`
- `runtime_file`
- `diagnostics_file`
- `command_runs_file`
- `section_outputs_dir`

## orchestration

- workflow graph
- permission profiles
- validators
- command bridge
- policy
- output settings
- execution settings
- FSM program
- parallel plan

## parallel_plan

The parallel plan is emitted when the user sets top-level `thread`/`threads`
or `program.threads`.

- `enabled`: whether automatic batching found useful concurrency
- `mode`: `off` or `auto`
- `max_threads`: bounded thread count, currently capped at 2 for heavy Claude work
- `batches`: task states that may be run by a coordinator in parallel
- `controls`: FSM thread-control operations for conditional cooperation

State-level controls:

- `parallel.thread`: logical thread id
- `parallel.resource`: resource key; states with the same key do not run in the same batch
- `parallel.depends_on`: state ids that must complete before this state
- `parallel.exclusive`: prevents automatic batching
- `parallel.starts_suspended`: prevents automatic batching until a coordinator resumes it
- `parallel.executor_class`: `long_running` or `temporary`
- `parallel.skills`: executor skill imports such as `pdf`
- `parallel.verifier_skills`: verifier-only audit skill imports
- `parallel.verifier`: `none`, `state`, `batch`, or `final`
- `parallel.workspace`: `primary` or `temporary`
- `parallel.merge_policy`: `none`, `handback`, `patch`, or `artifact_only`

FSM thread-control instructions:

- `thread_suspend`
- `thread_resume`
- `thread_interrupt`
- `thread_wait`

These write `context.threads.<thread>.status`, so transitions can test thread
state, for example:

```json
{
  "path": "threads.worker.status",
  "equals": "suspended"
}
```

## execution

Executor tiering separates durable state ownership from temporary parallel work.

- `long_running`
  - default agent: `tns-executor`
  - workspace: `primary`
  - persists state: true
  - owns durable handoff, section state, and final merge decisions
- `temporary`
  - default agent: `tns-temp-executor`
  - workspace: `temporary`
  - persists state: false
  - must report to `tns-executor`
  - `gc_after_run`: true
- `verifier`
  - default agent: `tns-verifier`
  - workspace: `primary`
  - persists state: false
  - must report to `tns-executor`
  - `gc_after_run`: true
  - should receive audit/readonly skills, not executor problem-solving skills

Temporary executors should produce a handback manifest or artifact list for the
long-running executor, then the coordinator should delete the temporary
workspace after the result is captured.

## skillbases

Skillbases are user-provided libraries of skills. A source can be an extracted
skillbase, a plugin library, or a direct directory of skill folders.

```json
{
  "skillbases": {
    "use_default_sources": true,
    "sources": [
      { "id": "local-bench", "path": "/abs/path/to/skillbase", "kind": "skillbase", "priority": 10 }
    ]
  }
}
```

Compiler output should treat natural-language requests like `import pdf` as
declarations. Put executor imports in `parallel.skills` and verifier imports in
`parallel.verifier_skills`; runtime resolves the names from configured
skillbases and records the selected source path during injection.

## externals

- `declared.tools`
- `declared.skills`
- `declared.mcp`
- `inferred_tools`

`declared.*` is the contract. `inferred_tools` is only a convenience inventory.
