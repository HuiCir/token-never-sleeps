This template validates TNS as a finite-state orchestration system.

Suggested flow:

```bash
tns compile --config ./tns_config.json
tns simulate --config ./tns_config.json
tns simulate --config ./tns_config.json --set approved=true --compact
```

What it covers:
- deterministic compiled FSM output
- `if` control flow
- `while` loop execution with max-iteration protection
- terminal state reachability
- traceable context mutation
