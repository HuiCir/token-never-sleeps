---
name: tns-start
description: Start or continue the Token Never Sleeps harness for a tracked workspace.
argument-hint: run --config /abs/path/to/tns_config.json | run-tmux --config /abs/path/to/tns_config.json
allowed-tools: ["Bash(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/tns_runner.py:*)"]
---

# TNS Start

Run the TNS harness command exactly as requested by the user arguments.

`run` auto-initializes if `.tns/manifest.json` does not exist yet.
`run-tmux` starts or restarts the managed tmux runner window.

Examples:

- `/tns-start run --config /abs/path/to/tns_config.json`
- `/tns-start run-tmux --config /abs/path/to/tns_config.json`
- `/tns-start run-tmux --config /abs/path/to/tns_config.json --restart`

```!
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/tns_runner.py" $ARGUMENTS
```
