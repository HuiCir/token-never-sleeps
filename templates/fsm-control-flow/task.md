# FSM Control Flow Validation

## Section 1
Compile this workspace into an explicit finite-state orchestration program and confirm the control-flow contract is complete.

Acceptance criteria:
- The compiled program exposes a normalized FSM.
- Required preflight inputs are explicit.
- External dependencies and runtime boundaries are declared.

## Section 2
Validate state flow with deterministic simulation, including branch and loop behavior.

Acceptance criteria:
- The FSM reaches its terminal state.
- `if` and `while` logic mutate context deterministically.
- Simulation trace is inspectable and stable.
