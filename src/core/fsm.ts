import type {
  FsmInstruction,
  FsmParallelBatch,
  FsmParallelPlan,
  FsmParallelPlanItem,
  FsmProgramSettings,
  FsmStateSpec,
  FsmThreadControlPlanItem,
} from "../types.js";

function instructionThreads(instruction: FsmInstruction): string[] {
  return Array.from(new Set([
    ...(instruction.thread ? [instruction.thread] : []),
    ...(Array.isArray(instruction.threads) ? instruction.threads : []),
  ].map(String).filter(Boolean)));
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
    .filter((state) => (state.parallel?.depends_on && state.parallel.depends_on.length > 0) || isAutoParallelCandidate(state))
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
      "FSM thread control instructions are compiled into control metadata for the runner",
      "external FSM editing remains closed; this is a compiled orchestration contract",
    ],
  };
}
