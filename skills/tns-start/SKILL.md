---
name: tns-start
description: Start or continue the Token Never Sleeps harness for a tracked workspace.
argument-hint: run --config /abs/path/to/tns_config.json
allowed-tools: ["Bash(python3 ${CLAUDE_PLUGIN_ROOT}/scripts/tns_runner.py:*)"]
---

# TNS Start

Run the TNS harness command exactly as requested by the user arguments.

`run` auto-initializes if `.tns/manifest.json` does not exist yet.

```!
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/tns_runner.py" $ARGUMENTS
```
