import { loadConfig } from "../lib/config.js";
import { statePaths, ensureInitialized, loadManifest } from "../core/state.js";
import { pathExists, readJson, removePath } from "../lib/fs.js";
import { currentWindow } from "../lib/time.js";
import { selectSection } from "../core/sections.js";
import { tmuxSettings, workflowSettings } from "../lib/config.js";
import { rebuildArtifactIndex } from "../core/artifacts.js";
import type { Section } from "../types.js";
import { probeTmux, tmuxPath, tmuxUnavailableStatus } from "../lib/platform.js";
import { writeJson } from "../lib/fs.js";
import { iso, utcNow } from "../lib/time.js";
import { pidIsAlive, readAllResourceLocks, readWorkspaceLock } from "../lib/lock.js";
import { loadRuntime } from "../core/runtime.js";
import { loadApprovals } from "../core/approvals.js";
import type { ExplorationState } from "../types.js";

export async function cmdStatus(args: { config?: string }): Promise<void> {
  const config = loadConfig(args.config);
  const paths = await ensureInitialized(config, { autoInit: false });
  const manifest = await loadManifest(paths);

  const sections = (await readJson<Section[]>(paths.sections)) || [];
  const counts: Record<string, number> = {};
  for (const s of sections) {
    counts[s.status] = (counts[s.status] || 0) + 1;
  }

  const window = currentWindow(manifest);
  const nextSection = selectSection(sections, 3);
  const artifacts = await rebuildArtifactIndex(paths);
  let freeze = await readJson(paths.freeze);
  if ((await pathExists(paths.freeze)) && (!freeze || typeof freeze !== "object")) {
    await removePath(paths.freeze);
    freeze = null;
  } else if (freeze && typeof freeze === "object" && typeof (freeze as Record<string, unknown>).until === "string") {
    const until = Date.parse((freeze as Record<string, unknown>).until as string);
    if (!Number.isNaN(until) && until <= Date.now()) {
      await removePath(paths.freeze);
      freeze = null;
    }
  }
  const tmuxCfg = tmuxSettings(config);
  let tmux = await readJson(paths.tmux);
  if (!tmuxCfg.enabled) {
    tmux = { enabled: false, available: Boolean(tmuxPath()), fallback: "direct", updated_at: iso(utcNow()) };
    await writeJson(paths.tmux, tmux);
  } else {
    const probe = await probeTmux(paths, tmuxCfg);
    if (!probe.available) {
      tmux = tmuxUnavailableStatus(paths, tmuxCfg, probe.reason);
      await writeJson(paths.tmux, tmux);
    } else if (!tmux || typeof tmux !== "object" || Object.keys(tmux as Record<string, unknown>).length === 0) {
      tmux = {
        enabled: true,
        available: true,
        fallback: undefined,
        workspace: paths.workspace,
        tmux_path: probe.path || undefined,
        updated_at: iso(utcNow()),
        manage_runner: tmuxCfg.manage_runner,
        runner_window_name: tmuxCfg.runner_window_name,
      };
      await writeJson(paths.tmux, tmux);
    }
  }

  const lock = await readWorkspaceLock(paths.workspace);
  const resourceLocks = await readAllResourceLocks(paths.workspace);
  const runtime = await loadRuntime(paths);
  const approvals = await loadApprovals(paths);
  const exploration = await readJson<ExplorationState>(paths.exploration);
  const diagnostics = await readJson<Record<string, unknown>>(paths.diagnostics, {});
  const runtimeHeartbeatAt = runtime?.heartbeat_at ? Date.parse(runtime.heartbeat_at) : NaN;
  const runtimeStale = Boolean(
    runtime?.active && (
      !pidIsAlive(runtime.pid) ||
      (!Number.isNaN(runtimeHeartbeatAt) && Date.now() - runtimeHeartbeatAt > 10 * 60 * 1000)
    )
  );
  const lockStale = Boolean(lock && !pidIsAlive(lock.pid));
  const resourceLockState = Object.fromEntries(Object.entries(resourceLocks).map(([name, info]) => [name, {
    ...info,
    stale: !pidIsAlive(info.pid),
  }]));
  const nextWakeAt = freeze && typeof (freeze as Record<string, unknown>).until === "string"
    ? ((freeze as Record<string, unknown>).until as string)
    : (runtime?.sleep_until ?? null);
  const status = {
    workspace: paths.workspace,
    window_index: window.index,
    window_start: window.start.toISOString(),
    window_end: window.end.toISOString(),
    freeze,
    lock,
    lock_stale: lockStale,
    resource_locks: resourceLockState,
    runtime,
    runtime_stale: runtimeStale,
    next_wake_at: nextWakeAt,
    counts,
    next_section: nextSection?.id || null,
    artifact_count: artifacts.length,
    approvals: {
      granted: Object.keys(approvals.granted).sort(),
      pending: Object.keys(approvals.pending).sort(),
    },
    diagnostics: {
      updated_at: diagnostics?.updated_at ?? null,
      last_error: diagnostics?.last_error ?? null,
      last_preflight_failures: Array.isArray(diagnostics?.last_preflight)
        ? diagnostics.last_preflight.filter((item: Record<string, unknown>) => item.ok === false).map((item: Record<string, unknown>) => item.id)
        : [],
      last_validator_failures: Array.isArray(diagnostics?.last_validator_results)
        ? diagnostics.last_validator_results.filter((item: Record<string, unknown>) => item.ok === false).map((item: Record<string, unknown>) => item.id)
        : [],
      last_recovery_decision: diagnostics?.last_recovery_decision ?? null,
    },
    compiled_program: {
      path: paths.compiled_program,
      exists: await pathExists(paths.compiled_program),
    },
    compiler_review: {
      path: paths.compiler_review,
      exists: await pathExists(paths.compiler_review),
    },
    exploration,
    workflow: workflowSettings(config),
    tmux,
  };

  console.log(JSON.stringify(status, null, 2));
}
