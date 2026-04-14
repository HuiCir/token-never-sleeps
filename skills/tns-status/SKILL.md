---
name: tns-status
description: Show Token Never Sleeps harness status for a tracked workspace.
argument-hint: --config /abs/path/to/tns_config.json
allowed-tools: ["Bash(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/tns_runner.py:*)"]
---

# TNS Status

Show the current TNS status.

```!
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/tns_runner.py" status $ARGUMENTS
```
