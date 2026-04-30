import type {
  FsmCondition,
  FsmInstruction,
  FsmParallelBatch,
  FsmParallelPlan,
  FsmParallelPlanItem,
  FsmProgramSettings,
  FsmSimulationResult,
  FsmSimulationTrace,
  FsmStateSpec,
  FsmThreadControlPlanItem,
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

function ensureThreadRecord(context: Record<string, unknown>, thread: string): Record<string, unknown> {
  const root = context.threads;
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    context.threads = {};
  }
  const threads = context.threads as Record<string, unknown>;
  const current = threads[thread];
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    threads[thread] = {
      status: "running",
      updated_at_step: 0,
      reason: "",
      history: [],
    };
  }
  return threads[thread] as Record<string, unknown>;
}

function setThreadStatus(context: Record<string, unknown>, thread: string, status: string, reason: string | undefined, events: string[]): void {
  const record = ensureThreadRecord(context, thread);
  const history = Array.isArray(record.history) ? record.history : [];
  const event = `thread:${status}:${thread}`;
  record.status = status;
  record.reason = reason ?? "";
  record.history = [...history, { status, reason: reason ?? "", event }];
  events.push(event);
}

function instructionThreads(instruction: FsmInstruction): string[] {
  return Array.from(new Set([
    ...(instruction.thread ? [instruction.thread] : []),
    ...(Array.isArray(instruction.threads) ? instruction.threads : []),
  ].map(String).filter(Boolean)));
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
    case "thread_suspend":
      for (const thread of instructionThreads(instruction)) {
        setThreadStatus(context, thread, "suspended", instruction.reason, events);
      }
      return;
    case "thread_resume":
      for (const thread of instructionThreads(instruction)) {
        setThreadStatus(context, thread, "running", instruction.reason, events);
      }
      return;
    case "thread_interrupt":
      for (const thread of instructionThreads(instruction)) {
        setThreadStatus(context, thread, "interrupted", instruction.reason, events);
      }
      return;
    case "thread_wait":
      for (const thread of instructionThreads(instruction)) {
        setThreadStatus(context, thread, "waiting", instruction.reason, events);
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

function isAutoParallelCandidate(state: FsmStateSpec): boolean {
  if (state.terminal || state.type === "terminal") return false;
  if (state.type && state.type !== "task") return false;
  if (state.parallel?.exclusive) return false;
  if (state.parallel?.starts_suspended) return false;
  const transitions = state.transitions ?? [];
  if (transitions.length > 1) return false;
  const transition = transitions[0];
  if (transition?.when || (transition?.actions && transition.actions.length > 0)) return false;
  return true;
}

function orderedReachableStates(program: FsmProgramSettings): FsmStateSpec[] {
  const states = new Map(program.states.map((state) => [state.id, state]));
  const ordered: FsmStateSpec[] = [];
  const visited = new Set<string>();
  let current = program.entry;
  while (current && !visited.has(current)) {
    visited.add(current);
    const state = states.get(current);
    if (!state) break;
    ordered.push(state);
    const transition = state.transitions?.[0];
    if (!transition || state.terminal || state.type === "terminal") break;
    if (state.transitions && state.transitions.length !== 1) break;
    current = transition.to;
  }
  return ordered;
}

function stateResource(state: FsmStateSpec): string {
  return state.parallel?.resource || `fsm:${state.id}`;
}

function stateThread(state: FsmStateSpec): string {
  return state.parallel?.thread || state.parallel?.group || state.id;
}

function buildPlanItem(state: FsmStateSpec, reason: string): FsmParallelPlanItem {
  return {
    state: state.id,
    thread: stateThread(state),
    resource: stateResource(state),
    depends_on: state.parallel?.depends_on ?? [],
    executor_class: state.parallel?.executor_class,
    verifier: state.parallel?.verifier,
    skills: state.parallel?.skills ?? [],
    verifier_skills: state.parallel?.verifier_skills ?? [],
    workspace: state.parallel?.workspace,
    merge_policy: state.parallel?.merge_policy,
    timeout_seconds: state.parallel?.timeout_seconds,
    reason,
  };
}

function hasResourceConflict(batch: FsmParallelPlanItem[], item: FsmParallelPlanItem): boolean {
  return batch.some((existing) => existing.resource === item.resource);
}

function explicitDependencyPlan(program: FsmProgramSettings, maxThreads: number): FsmParallelBatch[] {
  const candidates = orderedReachableStates(program)
    .filter((state) => state.parallel?.depends_on && state.parallel.depends_on.length > 0 || isAutoParallelCandidate(state))
    .filter((state) => !state.parallel?.exclusive)
    .map((state) => buildPlanItem(state, state.parallel?.depends_on?.length ? "explicit-dependencies" : "auto-linear-task"));
  const remaining = new Map(candidates.map((item) => [item.state, item]));
  const completed = new Set<string>();
  const batches: FsmParallelBatch[] = [];

  while (remaining.size > 0) {
    const selected: FsmParallelPlanItem[] = [];
    for (const item of remaining.values()) {
      if (selected.length >= maxThreads) break;
      if (!item.depends_on.every((dep) => completed.has(dep))) continue;
      if (hasResourceConflict(selected, item)) continue;
      selected.push(item);
    }
    if (selected.length === 0) break;
    for (const item of selected) {
      remaining.delete(item.state);
      completed.add(item.state);
    }
    batches.push({ id: `batch-${String(batches.length + 1).padStart(3, "0")}`, states: selected });
  }
  return batches;
}

function autoLinearPlan(program: FsmProgramSettings, maxThreads: number): FsmParallelBatch[] {
  const candidates = orderedReachableStates(program)
    .filter(isAutoParallelCandidate)
    .map((state) => buildPlanItem(state, "auto-linear-task"));
  const batches: FsmParallelBatch[] = [];
  let current: FsmParallelPlanItem[] = [];
  for (const item of candidates) {
    if (current.length >= maxThreads || hasResourceConflict(current, item)) {
      if (current.length > 0) {
        batches.push({ id: `batch-${String(batches.length + 1).padStart(3, "0")}`, states: current });
      }
      current = [];
    }
    current.push(item);
  }
  if (current.length > 0) {
    batches.push({ id: `batch-${String(batches.length + 1).padStart(3, "0")}`, states: current });
  }
  return batches;
}

function isThreadControlOp(op: string): op is FsmThreadControlPlanItem["op"] {
  return op === "thread_suspend" || op === "thread_resume" || op === "thread_interrupt" || op === "thread_wait";
}

function collectInstructionControls(stateId: string, instructions: FsmInstruction[] | undefined, controls: FsmThreadControlPlanItem[]): void {
  for (const instruction of instructions ?? []) {
    if (isThreadControlOp(instruction.op)) {
      controls.push({
        state: stateId,
        op: instruction.op,
        threads: instructionThreads(instruction),
        reason: instruction.reason ?? "",
      });
    }
    collectInstructionControls(stateId, instruction.then, controls);
    collectInstructionControls(stateId, instruction.else, controls);
    collectInstructionControls(stateId, instruction.body, controls);
  }
}

function collectThreadControls(program: FsmProgramSettings): FsmThreadControlPlanItem[] {
  const controls: FsmThreadControlPlanItem[] = [];
  for (const state of program.states) {
    collectInstructionControls(state.id, state.on_enter, controls);
    for (const transition of state.transitions ?? []) {
      collectInstructionControls(state.id, transition.actions, controls);
    }
  }
  return controls;
}

export function buildParallelPlan(program: FsmProgramSettings): FsmParallelPlan {
  const requestedThreads = Math.max(1, Number(program.threads ?? program.thread ?? program.parallel?.max_threads ?? 1));
  const maxThreads = Math.max(1, Math.min(2, Number(program.parallel?.max_threads ?? requestedThreads)));
  const mode = program.parallel?.mode ?? (requestedThreads > 1 ? "auto" : "off");
  const controls = collectThreadControls(program);
  if (mode === "off" || maxThreads <= 1) {
    return {
      enabled: false,
      mode: "off",
      max_threads: 1,
      batches: [],
      controls,
      notes: ["parallel optimization is disabled; set program.threads to 2 or program.parallel.mode to auto"],
    };
  }

  const hasExplicitDependencies = program.states.some((state) => (state.parallel?.depends_on ?? []).length > 0);
  const batches = hasExplicitDependencies
    ? explicitDependencyPlan(program, maxThreads)
    : autoLinearPlan(program, maxThreads);
  return {
    enabled: batches.some((batch) => batch.states.length > 1),
    mode: "auto",
    max_threads: maxThreads,
    batches,
    controls,
    notes: [
      "automatic FSM parallel planning is bounded to 2 threads on this machine profile",
      "only task states without conditional transitions or transition actions are auto-batched",
      "states sharing the same parallel.resource are not placed in the same batch",
      "FSM thread control instructions write context.threads.<thread>.status for conditional cooperation",
      "external FSM editing remains closed; this is a compiled/simulated orchestration contract",
    ],
  };
}

export function simulateProgram(program: FsmProgramSettings, initialContext?: Record<string, unknown>, maxStepsOverride?: number): FsmSimulationResult {
  const states = new Map(program.states.map((state) => [state.id, state]));
  const context = cloneContext({ ...(program.context ?? {}), ...(initialContext ?? {}) });
  const trace: FsmSimulationTrace[] = [];
  const maxSteps = Math.max(1, Number(maxStepsOverride ?? program.max_steps ?? 100));
  let currentState = program.entry;
  const parallelPlan = buildParallelPlan(program);

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
        parallel_plan: parallelPlan,
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
        parallel_plan: parallelPlan,
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
        parallel_plan: parallelPlan,
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
    parallel_plan: parallelPlan,
  };
}
