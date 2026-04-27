import type {
  FsmCondition,
  FsmInstruction,
  FsmProgramSettings,
  FsmSimulationResult,
  FsmSimulationTrace,
  FsmStateSpec,
  FsmTransitionSpec,
} from "../types.js";

function cloneContext(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input ?? {})) as Record<string, unknown>;
}

function pathValue(context: Record<string, unknown>, path: string | undefined): unknown {
  if (!path) return undefined;
  const parts = path.split(".");
  let current: unknown = context;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setPathValue(context: Record<string, unknown>, path: string | undefined, value: unknown): void {
  if (!path) return;
  const parts = path.split(".");
  let current: Record<string, unknown> = context;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const next = current[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

export function matchesCondition(context: Record<string, unknown>, cond: FsmCondition | undefined): boolean {
  if (!cond) return true;
  const value = pathValue(context, cond.path);
  if (cond.equals !== undefined) return value === cond.equals;
  if (cond.not_equals !== undefined) return value !== cond.not_equals;
  if (cond.in !== undefined) return cond.in.includes(value as never);
  if (cond.truthy === true) return Boolean(value);
  if (cond.truthy === false) return !Boolean(value);
  if (typeof cond.lt === "number") return Number(value) < cond.lt;
  if (typeof cond.lte === "number") return Number(value) <= cond.lte;
  if (typeof cond.gt === "number") return Number(value) > cond.gt;
  if (typeof cond.gte === "number") return Number(value) >= cond.gte;
  return true;
}

function executeInstruction(context: Record<string, unknown>, instruction: FsmInstruction, events: string[]): void {
  switch (instruction.op) {
    case "set":
      setPathValue(context, instruction.path, instruction.value ?? null);
      return;
    case "inc":
      setPathValue(context, instruction.path, Number(pathValue(context, instruction.path) ?? 0) + Number(instruction.by ?? 1));
      return;
    case "dec":
      setPathValue(context, instruction.path, Number(pathValue(context, instruction.path) ?? 0) - Number(instruction.by ?? 1));
      return;
    case "append": {
      const current = pathValue(context, instruction.path);
      const next = Array.isArray(current) ? [...current, instruction.value] : [instruction.value];
      setPathValue(context, instruction.path, next);
      return;
    }
    case "emit":
      if (instruction.event) {
        events.push(instruction.event);
      }
      return;
    case "if":
      if (matchesCondition(context, instruction.cond)) {
        executeInstructions(context, instruction.then ?? [], events);
      } else {
        executeInstructions(context, instruction.else ?? [], events);
      }
      return;
    case "while": {
      const maxIterations = Math.max(1, Number(instruction.max_iterations ?? 32));
      let iterations = 0;
      while (matchesCondition(context, instruction.cond)) {
        executeInstructions(context, instruction.body ?? [], events);
        iterations += 1;
        if (iterations >= maxIterations) {
          events.push(`while:max-iterations:${maxIterations}`);
          break;
        }
      }
      return;
    }
    default:
      return;
  }
}

export function executeInstructions(context: Record<string, unknown>, instructions: FsmInstruction[] | undefined, events: string[]): void {
  for (const instruction of instructions ?? []) {
    executeInstruction(context, instruction, events);
  }
}

function chooseTransition(context: Record<string, unknown>, state: FsmStateSpec): { transition: FsmTransitionSpec | null; reason: string } {
  const transitions = state.transitions ?? [];
  for (const transition of transitions) {
    if (matchesCondition(context, transition.when)) {
      return { transition, reason: transition.when ? "condition-matched" : "fallthrough" };
    }
  }
  return { transition: null, reason: transitions.length > 0 ? "no-transition-matched" : "no-transitions-defined" };
}

export function simulateProgram(program: FsmProgramSettings, initialContext?: Record<string, unknown>, maxStepsOverride?: number): FsmSimulationResult {
  const states = new Map(program.states.map((state) => [state.id, state]));
  const context = cloneContext({ ...(program.context ?? {}), ...(initialContext ?? {}) });
  const trace: FsmSimulationTrace[] = [];
  const maxSteps = Math.max(1, Number(maxStepsOverride ?? program.max_steps ?? 100));
  let currentState = program.entry;

  for (let step = 0; step < maxSteps; step += 1) {
    const state = states.get(currentState);
    if (!state) {
      return {
        ok: false,
        reason: `state not found: ${currentState}`,
        steps: step,
        terminal_state: null,
        trace,
        final_context: context,
      };
    }

    const events: string[] = [];
    executeInstructions(context, state.on_enter, events);

    if (state.terminal || state.type === "terminal") {
      trace.push({
        state: state.id,
        step,
        events,
        context: cloneContext(context),
        transition: null,
      });
      return {
        ok: true,
        reason: "terminal-state-reached",
        steps: step + 1,
        terminal_state: state.id,
        trace,
        final_context: context,
      };
    }

    const { transition, reason } = chooseTransition(context, state);
    if (!transition) {
      trace.push({
        state: state.id,
        step,
        events,
        context: cloneContext(context),
        transition: {
          from: state.id,
          to: state.id,
          transition_id: "none",
          matched: false,
          reason,
        },
      });
      return {
        ok: false,
        reason,
        steps: step + 1,
        terminal_state: null,
        trace,
        final_context: context,
      };
    }

    executeInstructions(context, transition.actions, events);
    trace.push({
      state: state.id,
      step,
      events,
      context: cloneContext(context),
      transition: {
        from: state.id,
        to: transition.to,
        transition_id: transition.id ?? "transition",
        matched: true,
        reason,
      },
    });
    currentState = transition.to;
  }

  return {
    ok: false,
    reason: `max-steps-exceeded:${maxSteps}`,
    steps: maxSteps,
    terminal_state: null,
    trace,
    final_context: context,
  };
}
