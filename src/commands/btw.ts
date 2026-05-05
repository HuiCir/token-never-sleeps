import { readFile } from "node:fs/promises";
import { loadConfig } from "../lib/config.js";
import { pathExists, readJson } from "../lib/fs.js";
import { currentWindow, iso, utcNow } from "../lib/time.js";
import { statePaths } from "../core/state.js";
import { pidIsAlive, readAllResourceLocks, readWorkspaceLock } from "../lib/lock.js";
import type { ActivityEvent, ArtifactRecord, ExplorationState, FreezeRecord, Manifest, ReviewRecord, Section, TmuxStatus } from "../types.js";
import { ensureSectionDefaults, selectSection } from "../core/sections.js";
import { loadRuntime } from "../core/runtime.js";
import { loadApprovals } from "../core/approvals.js";

interface BtwArgs {
  config?: string;
  events?: number;
  reviews?: number;
}

function asArray<T>(value: T[] | null): T[] {
  return Array.isArray(value) ? value : [];
}

async function readJsonlTail<T>(path: string, limit: number): Promise<T[]> {
  if (limit <= 0) {
    return [];
  }
  try {
    const content = await readFile(path, "utf-8");
    const lines = content
      .split("\n")
      .filter((line) => line.trim().length > 0);
    return lines
      .slice(Math.max(lines.length - limit, 0))
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

function summarizeCounts(sections: Section[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const section of sections) {
    ensureSectionDefaults(section);
    counts[section.status] = (counts[section.status] || 0) + 1;
  }
  return counts;
}

function currentSectionSnapshot(sections: Section[]): Pick<Section, "id" | "title" | "status" | "attempts" | "current_step" | "last_summary" | "last_review"> | null {
  const inProgress = sections.find((section) => section.status === "in_progress");
  const selected = inProgress || selectSection(sections.map((section) => ({ ...section })), 3);
  if (!selected) {
    return null;
  }
  return {
    id: selected.id,
    title: selected.title,
    status: selected.status,
    attempts: selected.attempts,
    current_step: selected.current_step,
    last_summary: selected.last_summary,
    last_review: selected.last_review,
  };
}

export async function cmdBtw(args: BtwArgs): Promise<void> {
  const config = loadConfig(args.config);
  const paths = statePaths(config);
  const eventLimit = Math.max(0, args.events ?? 8);
  const reviewLimit = Math.max(0, args.reviews ?? 3);

  if (!(await pathExists(paths.manifest))) {
    throw new Error(`workspace not initialized: ${paths.manifest}`);
  }

  const manifest = await readJson<Manifest>(paths.manifest);
  if (!manifest) {
    throw new Error(`manifest not found: ${paths.manifest}`);
  }

  const sections = asArray(await readJson<Section[]>(paths.sections, []));
  sections.forEach(ensureSectionDefaults);
  const counts = summarizeCounts(sections);
  const currentSection = currentSectionSnapshot(sections);
  const nextSection = selectSection(sections.map((section) => ({ ...section })), 3)?.id || null;

  const artifacts = asArray(await readJson<ArtifactRecord[]>(paths.artifacts, []));
  const reviews = asArray(await readJson<ReviewRecord[]>(paths.reviews, []));
  const freeze = await readJson<FreezeRecord>(paths.freeze);
  const tmux = await readJson<TmuxStatus>(paths.tmux);
  const exploration = await readJson<ExplorationState>(paths.exploration);
  const diagnostics = await readJson<Record<string, unknown>>(paths.diagnostics);
  const gateway = await readJson<Record<string, unknown>>(paths.gateway_status, {});
  const gatewayClients = await readJson<Record<string, unknown>>(paths.gateway_clients, {});
  const gatewayTasks = await readJson<Array<Record<string, unknown>>>(paths.gateway_tasks, []);
  const runtime = await loadRuntime(paths);
  const approvals = await loadApprovals(paths);
  const lock = await readWorkspaceLock(paths.workspace);
  const resourceLocks = await readAllResourceLocks(paths.workspace);
  const recentActivity = await readJsonlTail<ActivityEvent>(paths.activity, eventLimit);

  const runtimeHeartbeatAt = runtime?.heartbeat_at ? Date.parse(runtime.heartbeat_at) : NaN;
  const runtimeStale = Boolean(
    runtime?.active && (
      !pidIsAlive(runtime.pid) ||
      (!Number.isNaN(runtimeHeartbeatAt) && Date.now() - runtimeHeartbeatAt > 10 * 60 * 1000)
    )
  );
  const lockStale = Boolean(lock && !pidIsAlive(lock.pid));
  const window = currentWindow(manifest);
  const nextWakeAt = freeze?.until || runtime?.sleep_until || null;

  const snapshot = {
    workspace: paths.workspace,
    observed_at: iso(utcNow()),
    read_only: true,
    window: {
      index: window.index,
      start: window.start.toISOString(),
      end: window.end.toISOString(),
    },
    runner: runtime ? {
      active: runtime.active,
      mode: runtime.mode,
      pid: runtime.pid,
      stale: runtimeStale,
      heartbeat_at: runtime.heartbeat_at,
      sleep_until: runtime.sleep_until,
      last_exit_at: runtime.last_exit_at,
      last_exit_reason: runtime.last_exit_reason,
      current_section: runtime.current_section || null,
      current_step: runtime.current_step || null,
      current_agent: runtime.current_agent || null,
      agent_pid: runtime.agent_pid ?? null,
      agent_started_at: runtime.agent_started_at ?? null,
      agent_deadline_at: runtime.agent_deadline_at ?? null,
      session_name: runtime.session_name,
      runner_window_name: runtime.runner_window_name,
    } : null,
    freeze: freeze ? {
      reason: freeze.reason,
      at: freeze.at,
      until: freeze.until,
      window: freeze.window,
      active: Date.parse(freeze.until) > Date.now(),
    } : null,
    lock: lock ? {
      ...lock,
      stale: lockStale,
    } : null,
    resource_locks: Object.fromEntries(Object.entries(resourceLocks).map(([name, info]) => [name, {
      ...info,
      stale: !pidIsAlive(info.pid),
    }])),
    task: {
      total_sections: sections.length,
      counts,
      current_section: currentSection,
      next_section: nextSection,
    },
    artifacts: {
      count: artifacts.length,
    },
    approvals: {
      granted: Object.keys(approvals.granted).sort(),
      pending: Object.keys(approvals.pending).sort(),
    },
    diagnostics: diagnostics ? {
      updated_at: diagnostics.updated_at ?? null,
      last_error: diagnostics.last_error ?? null,
      last_preflight_failures: Array.isArray(diagnostics.last_preflight)
        ? diagnostics.last_preflight.filter((item: Record<string, unknown>) => item.ok === false).map((item: Record<string, unknown>) => item.id)
        : [],
      last_validator_failures: Array.isArray(diagnostics.last_validator_results)
        ? diagnostics.last_validator_results.filter((item: Record<string, unknown>) => item.ok === false).map((item: Record<string, unknown>) => item.id)
        : [],
      last_recovery_decision: diagnostics.last_recovery_decision ?? null,
    } : null,
    compiled_program: {
      path: paths.compiled_program,
      exists: await pathExists(paths.compiled_program),
    },
    compiler_review: {
      path: paths.compiler_review,
      exists: await pathExists(paths.compiler_review),
    },
    exploration: exploration ? {
      window_index: exploration.window_index,
      rounds_run: exploration.rounds_run,
      last_outcome: exploration.last_outcome,
      last_summary: exploration.last_summary,
      last_taskx_path: exploration.last_taskx_path,
      updated_at: exploration.updated_at,
    } : null,
    gateway: {
      status: gateway,
      clients: Object.keys(gatewayClients ?? {}).sort(),
      tasks: {
        total: Array.isArray(gatewayTasks) ? gatewayTasks.length : 0,
        pending: Array.isArray(gatewayTasks) ? gatewayTasks.filter((task) => task.status === "pending").length : 0,
        claimed: Array.isArray(gatewayTasks) ? gatewayTasks.filter((task) => task.status === "claimed").length : 0,
        done: Array.isArray(gatewayTasks) ? gatewayTasks.filter((task) => task.status === "done").length : 0,
      },
      events: paths.gateway_events,
    },
    tmux: tmux || null,
    next_wake_at: nextWakeAt,
    recent_reviews: reviewLimit > 0 ? reviews.slice(Math.max(reviews.length - reviewLimit, 0)) : [],
    recent_activity: recentActivity,
  };

  console.log(JSON.stringify(snapshot, null, 2));
}
