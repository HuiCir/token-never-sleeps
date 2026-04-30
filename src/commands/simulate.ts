import { loadConfig, programSettings } from "../lib/config.js";
import { ensureInitialized, statePaths } from "../core/state.js";
import { pathExists, readJson } from "../lib/fs.js";
import { simulateProgram } from "../core/fsm.js";
import type { FsmProgramSettings } from "../types.js";

function parseLiteral(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (!Number.isNaN(Number(raw)) && raw.trim() !== "") return Number(raw);
  return raw;
}

function parseContextPairs(items: string[] | undefined): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  for (const item of items ?? []) {
    const idx = item.indexOf("=");
    if (idx <= 0) continue;
    context[item.slice(0, idx)] = parseLiteral(item.slice(idx + 1));
  }
  return context;
}

export async function cmdSimulate(args: { config: string; set?: string[]; max_steps?: number; maxSteps?: number; compact?: boolean }): Promise<void> {
  const config = loadConfig(args.config);
  const paths = await ensureInitialized(config, { autoInit: false });
  let program = programSettings(config);
  if (!program && await pathExists(paths.compiled_program)) {
    const compiled = await readJson<Record<string, unknown>>(paths.compiled_program);
    const candidate = compiled?.orchestration && typeof compiled.orchestration === "object"
      ? (compiled.orchestration as Record<string, unknown>).program
      : (compiled?.inputs && typeof compiled.inputs === "object" ? (compiled.inputs as Record<string, unknown>).program : null);
    if (candidate && typeof candidate === "object") {
      program = candidate as FsmProgramSettings;
    }
  }

  if (!program) {
    throw new Error("no FSM program is configured or compiled for this workspace");
  }

  const result = simulateProgram(program, parseContextPairs(args.set), args.max_steps ?? args.maxSteps);
  if (args.compact) {
    console.log(JSON.stringify({
      ok: result.ok,
      reason: result.reason,
      steps: result.steps,
      terminal_state: result.terminal_state,
      final_context: result.final_context,
      parallel_plan: result.parallel_plan ? {
        enabled: result.parallel_plan.enabled,
        mode: result.parallel_plan.mode,
        max_threads: result.parallel_plan.max_threads,
        batches: result.parallel_plan.batches.map((batch) => ({
          id: batch.id,
          states: batch.states.map((item) => ({
            state: item.state,
            thread: item.thread,
          })),
        })),
        controls: result.parallel_plan.controls,
      } : undefined,
    }, null, 2));
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}
