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

## inputs

- `preflight`
- parsed task sections

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

## externals

- `declared.tools`
- `declared.skills`
- `declared.mcp`
- `inferred_tools`

`declared.*` is the contract. `inferred_tools` is only a convenience inventory.
