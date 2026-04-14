---
name: tns-start
description: Start or continue the Token Never Sleeps harness for a tracked product document.
argument-hint: --config /abs/path/to/tns.config.json [run|init|status]
allowed-tools: ["Bash(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/tns_runner.py:*)"]
---

# TNS Start

Run the TNS harness command exactly as requested by the user arguments.

```!
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/tns_runner.py" $ARGUMENTS
```
