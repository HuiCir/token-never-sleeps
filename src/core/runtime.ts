import { appendJsonl, readJson, removePath, writeJson } from "../lib/fs.js";
import { pidIsAlive } from "../lib/lock.js";
import { iso, utcNow } from "../lib/time.js";
import type { RuntimeState, Section, StatePaths } from "../types.js";
import { recoverInProgressSections } from "./sections.js";

const DEFAULT_RUNTIME_STALE_MS = 10 * 60 * 1000;

export async function loadRuntime(paths: StatePaths): Promise<RuntimeState | null> {
  return readJson<RuntimeState>(paths.runtime);
}

export async function updateRuntime(paths: StatePaths, patch: Partial<RuntimeState>): Promise<RuntimeState> {
  const current = (await loadRuntime(paths)) || {
    active: false,
    mode: "direct" as const,
    pid: null,
    command: "",
    started_at: iso(utcNow()),
    heartbeat_at: iso(utcNow()),
    current_section: "",
    current_step: "",
    window_index: null,
    sleep_until: null,
    current_agent: null,
    agent_pid: null,
    agent_started_at: null,
    agent_deadline_at: null,
  };
  const next: RuntimeState = {
    ...current,
    ...patch,
    heartbeat_at: patch.heartbeat_at ?? iso(utcNow()),
  };
  await writeJson(paths.runtime, next);
  return next;
}

export async function beginRuntime(paths: StatePaths, command: string, mode: "direct" | "tmux", extra?: Partial<RuntimeState>): Promise<void> {
  const now = iso(utcNow());
  await writeJson(paths.runtime, {
    active: true,
    mode,
    pid: process.pid,
    command,
    started_at: now,
    heartbeat_at: now,
    current_section: extra?.current_section ?? "",
    current_step: extra?.current_step ?? "",
    window_index: extra?.window_index ?? null,
    sleep_until: extra?.sleep_until ?? null,
    session_name: extra?.session_name,
    runner_window_name: extra?.runner_window_name,
    current_agent: extra?.current_agent ?? null,
    agent_pid: extra?.agent_pid ?? null,
    agent_started_at: extra?.agent_started_at ?? null,
    agent_deadline_at: extra?.agent_deadline_at ?? null,
    last_exit_at: undefined,
    last_exit_reason: undefined,
    recovery_note: undefined,
  });
}

export async function heartbeatRuntime(paths: StatePaths, patch?: Partial<RuntimeState>): Promise<void> {
  await updateRuntime(paths, patch ?? {});
}

export async function endRuntime(paths: StatePaths, reason: string): Promise<void> {
  const existing = await loadRuntime(paths);
  if (!existing) {
    return;
  }
  await writeJson(paths.runtime, {
    ...existing,
    active: false,
    pid: null,
    heartbeat_at: iso(utcNow()),
    sleep_until: null,
    current_agent: null,
    agent_pid: null,
    agent_started_at: null,
    agent_deadline_at: null,
    last_exit_at: iso(utcNow()),
    last_exit_reason: reason,
  });
}

export async function clearRuntime(paths: StatePaths): Promise<void> {
  await removePath(paths.runtime);
}

export async function recoverRuntimeIfInterrupted(paths: StatePaths, staleMs: number = DEFAULT_RUNTIME_STALE_MS): Promise<{ recovered: boolean; reason?: string }> {
  const runtime = await loadRuntime(paths);
  if (!runtime || !runtime.active) {
    return { recovered: false };
  }

  // Semantic recovery: if all sections are terminal, the runner should have exited
  const sections = (await readJson<Section[]>(paths.sections)) || [];
  const allTerminal = sections.length > 0 && sections.every(
    (s) => s.status === "done" || s.status === "blocked"
  );

  if (allTerminal) {
    await writeJson(paths.runtime, {
      ...runtime,
      active: false,
      pid: null,
      heartbeat_at: iso(utcNow()),
      current_section: "",
      current_step: "",
      sleep_until: null,
      current_agent: null,
      agent_pid: null,
      agent_started_at: null,
      agent_deadline_at: null,
      last_exit_at: iso(utcNow()),
      last_exit_reason: "semantic_recovery_all_sections_terminal",
      recovery_note: `Auto-recovered: all ${sections.length} sections terminal at ${iso(utcNow())}`,
    });
    await appendJsonl(paths.activity, {
      event: "runner_semantic_recovery",
      at: iso(utcNow()),
      reason: "semantic_all_terminal",
      sections_done: sections.filter((s) => s.status === "done").length,
      sections_blocked: sections.filter((s) => s.status === "blocked").length,
      previous_pid: runtime.pid,
    });
    return { recovered: true, reason: "semantic_all_terminal" };
  }

  const heartbeatAt = Date.parse(runtime.heartbeat_at || runtime.started_at);
  const heartbeatAgeMs = Number.isNaN(heartbeatAt) ? Number.MAX_SAFE_INTEGER : Date.now() - heartbeatAt;
  const pidAlive = pidIsAlive(runtime.pid);
  const staleHeartbeat = heartbeatAgeMs > staleMs;
  if (pidAlive && !staleHeartbeat) {
    return { recovered: false };
  }

  const changed = recoverInProgressSections(sections);
  if (changed) {
    await writeJson(paths.sections, sections);
  }

  const reason = pidAlive ? "stale_heartbeat" : "process_not_alive";
  await writeJson(paths.runtime, {
    ...runtime,
    active: false,
    pid: null,
    heartbeat_at: iso(utcNow()),
    current_section: "",
    current_step: "",
    sleep_until: null,
    current_agent: null,
    agent_pid: null,
    agent_started_at: null,
    agent_deadline_at: null,
    last_exit_at: iso(utcNow()),
    last_exit_reason: reason,
    recovery_note: `Recovered interrupted runner at ${iso(utcNow())}`,
  });
  await appendJsonl(paths.activity, {
    event: "runner_recovered",
    at: iso(utcNow()),
    reason,
    changed_sections: changed,
    previous_pid: runtime.pid,
  });
  return { recovered: true, reason };
}
