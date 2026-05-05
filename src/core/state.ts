import { resolve } from "node:path";
import { writeJson, readJson, writeText, removePath, pathExists } from "../lib/fs.js";
import { iso, utcNow } from "../lib/time.js";
import type { TnsConfig, Manifest, StatePaths } from "../types.js";
import { parseSections } from "./sections.js";

export function statePaths(config: TnsConfig): StatePaths {
  const workspace = resolve(config.workspace);
  const stateDir = `${workspace}/.tns`;
  return {
    workspace,
    state_dir: stateDir,
    manifest: `${stateDir}/manifest.json`,
    sections: `${stateDir}/sections.json`,
    handoff: `${stateDir}/handoff.md`,
    reviews: `${stateDir}/reviews.json`,
    freeze: `${stateDir}/freeze.json`,
    activity: `${stateDir}/activity.jsonl`,
    artifacts: `${stateDir}/artifacts.json`,
    tmux: `${stateDir}/tmux.json`,
    runtime: `${stateDir}/runtime.json`,
    approvals: `${stateDir}/approvals.json`,
    exploration: `${stateDir}/exploration.json`,
    diagnostics: `${stateDir}/diagnostics.json`,
    command_runs: `${stateDir}/command-runs.jsonl`,
    section_outputs_dir: `${stateDir}/section-outputs`,
    compiled_dir: `${stateDir}/compiled`,
    compiled_program: `${stateDir}/compiled/program.json`,
    compiler_review: `${stateDir}/compiled/compiler-review.json`,
    task_plan_review: `${stateDir}/compiled/task-plan-review.json`,
    lock_events: `${stateDir}/lock-events.jsonl`,
    tool_events: `${stateDir}/tool-events.jsonl`,
    injection_events: `${stateDir}/injection-events.jsonl`,
    agent_runs_dir: `${stateDir}/agent-runs`,
    hook_events: `${stateDir}/hook-events.jsonl`,
    runner_log: `${stateDir}/runner.log`,
    gateway_dir: `${stateDir}/gateway`,
    gateway_inbox: `${stateDir}/gateway/inbox.jsonl`,
    gateway_events: `${stateDir}/gateway/events.jsonl`,
    gateway_status: `${stateDir}/gateway/status.json`,
    gateway_clients: `${stateDir}/gateway/clients.json`,
    gateway_tasks: `${stateDir}/gateway/tasks.json`,
    gateway_responses_dir: `${stateDir}/gateway/responses`,
  };
}

export async function loadManifest(paths: StatePaths): Promise<Manifest> {
  const manifest = await readJson<Manifest>(paths.manifest);
  if (!manifest) throw new Error(`manifest not found: ${paths.manifest}`);
  return manifest;
}

export async function initState(config: TnsConfig): Promise<void> {
  const paths = statePaths(config);
  const productDoc = resolve(config.product_doc);
  const startedAt = utcNow();

  const manifest: Manifest = {
    started_at: iso(startedAt),
    product_doc: productDoc,
    refresh_anchor_at: iso(startedAt),
    refresh_hours: config.refresh_hours ?? 1,
    refresh_minutes: config.refresh_minutes ?? null,
    refresh_seconds: config.refresh_seconds ?? null,
  };

  await writeJson(paths.manifest, manifest);
  await writeText(paths.handoff, "# TNS Handoff\n\nThis file is appended by the harness after each executor/verifier cycle.\n");

  const sections = parseSections(productDoc);

  await writeJson(paths.sections, sections);
  await writeJson(paths.reviews, []);
  await writeJson(paths.artifacts, []);
  await writeJson(paths.approvals, { granted: {}, pending: {} });
  await writeJson(paths.exploration, {
    window_index: null,
    rounds_run: 0,
    last_outcome: "idle",
    last_summary: "",
    last_taskx_path: null,
    updated_at: null,
  });
  await writeJson(paths.diagnostics, {
    updated_at: null,
    last_preflight: [],
    last_validator_results: [],
    last_command_runs: [],
    last_error: null,
  });
  await removePath(paths.freeze);
  await writeJson(paths.tmux, {});
  await writeJson(paths.gateway_clients, {});
  await writeJson(paths.gateway_tasks, []);
  await writeJson(paths.gateway_status, {
    active: false,
    protocol_version: 1,
    updated_at: null,
    processed_ids: [],
    waiters: [],
  });
  await removePath(paths.runtime);

  const { appendJsonl } = await import("../lib/fs.js");
  await appendJsonl(paths.activity, { event: "init", at: iso(startedAt), sections: sections.length });
}

export async function ensureInitialized(config: TnsConfig, options?: { autoInit?: boolean }): Promise<StatePaths> {
  const paths = statePaths(config);
  const manifestExists = await pathExists(paths.manifest);
  const autoInit = options?.autoInit ?? true;

  if (!manifestExists && autoInit) {
    await initState(config);
  }

  if (!manifestExists && !autoInit) {
    throw new Error(`workspace not initialized: ${paths.manifest}`);
  }

  return paths;
}
