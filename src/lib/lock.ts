import { appendFile } from "node:fs/promises";
import { open, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";

export interface WorkspaceLockInfo {
  pid: number;
  command: string;
  acquired_at: string;
  workspace: string;
  resource: string;
}

const DEFAULT_STALE_MS = 30 * 60 * 1000;
const DEFAULT_WAIT_MS = 15 * 1000;
const POLL_MS = 200;
const HELD_LOCKS = new Map<string, number>();

function locksDirForWorkspace(workspace: string): string {
  return resolve(workspace, ".tns", "locks");
}

function lockPathForResource(workspace: string, resource: string): string {
  return resolve(locksDirForWorkspace(workspace), `${resource}.lock`);
}

function lockEventsPathForWorkspace(workspace: string): string {
  return resolve(workspace, ".tns", "lock-events.jsonl");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function readLockFile(path: string): Promise<WorkspaceLockInfo | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as WorkspaceLockInfo;
  } catch {
    return null;
  }
}

async function appendLockEvent(workspace: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(resolve(workspace, ".tns"), { recursive: true });
    await appendFile(lockEventsPathForWorkspace(workspace), JSON.stringify(payload) + "\n", "utf-8");
  } catch {
    // best effort only
  }
}

export function pidIsAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function removeIfStale(path: string, staleMs: number): Promise<void> {
  const info = await readLockFile(path);
  if (!info) {
    await rm(path, { force: true });
    return;
  }
  if (pidIsAlive(info.pid)) {
    return;
  }
  const acquiredAt = Date.parse(info.acquired_at);
  if (Number.isNaN(acquiredAt)) {
    await rm(path, { force: true });
    return;
  }
  if (Date.now() - acquiredAt > staleMs || !pidIsAlive(info.pid)) {
    await rm(path, { force: true });
    await appendLockEvent(info.workspace, {
      event: "lock_stale_removed",
      at: new Date().toISOString(),
      resource: info.resource,
      pid: info.pid,
      command: info.command,
    });
  }
}

async function acquireOneResourceLock(workspace: string, resource: string, command: string, options?: { waitMs?: number; staleMs?: number }): Promise<() => Promise<void>> {
  const normalizedWorkspace = resolve(workspace);
  const lockPath = lockPathForResource(normalizedWorkspace, resource);
  const waitMs = options?.waitMs ?? DEFAULT_WAIT_MS;
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + waitMs;

  await mkdir(locksDirForWorkspace(normalizedWorkspace), { recursive: true });

  const heldCount = HELD_LOCKS.get(lockPath) ?? 0;
  if (heldCount > 0) {
    HELD_LOCKS.set(lockPath, heldCount + 1);
    await appendLockEvent(normalizedWorkspace, {
      event: "lock_reentrant_acquire",
      at: new Date().toISOString(),
      resource,
      pid: process.pid,
      command,
      depth: heldCount + 1,
    });
    return async () => {
      const next = (HELD_LOCKS.get(lockPath) ?? 1) - 1;
      if (next <= 0) {
        HELD_LOCKS.delete(lockPath);
      } else {
        HELD_LOCKS.set(lockPath, next);
      }
      await appendLockEvent(normalizedWorkspace, {
        event: "lock_reentrant_release",
        at: new Date().toISOString(),
        resource,
        pid: process.pid,
        command,
        depth: Math.max(next, 0),
      });
    };
  }

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      const info: WorkspaceLockInfo = {
        pid: process.pid,
        command,
        acquired_at: new Date().toISOString(),
        workspace: normalizedWorkspace,
        resource,
      };
      await handle.writeFile(JSON.stringify(info, null, 2) + "\n", "utf-8");
      await handle.close();
      HELD_LOCKS.set(lockPath, 1);
      await appendLockEvent(normalizedWorkspace, {
        event: "lock_acquire",
        at: new Date().toISOString(),
        resource,
        pid: process.pid,
        command,
      });
      return async () => {
        const next = (HELD_LOCKS.get(lockPath) ?? 1) - 1;
        if (next <= 0) {
          HELD_LOCKS.delete(lockPath);
          await rm(lockPath, { force: true });
        } else {
          HELD_LOCKS.set(lockPath, next);
        }
        await appendLockEvent(normalizedWorkspace, {
          event: "lock_release",
          at: new Date().toISOString(),
          resource,
          pid: process.pid,
          command,
        });
      };
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }
      await removeIfStale(lockPath, staleMs);
      if (Date.now() >= deadline) {
        const holder = await readLockFile(lockPath);
        await appendLockEvent(normalizedWorkspace, {
          event: "lock_timeout",
          at: new Date().toISOString(),
          resource,
          pid: process.pid,
          command,
          holder,
        });
        const suffix = holder
          ? ` resource ${resource} held by pid ${holder.pid} running ${holder.command} since ${holder.acquired_at}`
          : ` resource ${resource} lock file still present`;
        throw new Error(`workspace is busy:${suffix}`);
      }
      await sleep(POLL_MS);
    }
  }
}

export async function readResourceLock(workspace: string, resource: string): Promise<WorkspaceLockInfo | null> {
  return readLockFile(lockPathForResource(resolve(workspace), resource));
}

export async function readAllResourceLocks(workspace: string): Promise<Record<string, WorkspaceLockInfo>> {
  const locksDir = locksDirForWorkspace(resolve(workspace));
  try {
    const files = await readdir(locksDir);
    const entries = await Promise.all(files
      .filter((name) => name.endsWith(".lock"))
      .map(async (name) => {
        const info = await readLockFile(resolve(locksDir, name));
        return info ? [basename(name, ".lock"), info] as const : null;
      }));
    return Object.fromEntries(entries.filter((item): item is readonly [string, WorkspaceLockInfo] => item !== null));
  } catch {
    return {};
  }
}

export async function readWorkspaceLock(workspace: string): Promise<WorkspaceLockInfo | null> {
  return readResourceLock(workspace, "workspace");
}

export async function withResourceLock<T>(
  workspace: string,
  resource: string,
  command: string,
  action: () => Promise<T>,
  options?: { waitMs?: number; staleMs?: number }
): Promise<T> {
  const release = await acquireOneResourceLock(workspace, resource, command, options);
  try {
    return await action();
  } finally {
    await release();
  }
}

export async function withResourceLocks<T>(
  workspace: string,
  resources: string[],
  command: string,
  action: () => Promise<T>,
  options?: { waitMs?: number; staleMs?: number }
): Promise<T> {
  const unique = Array.from(new Set(resources)).sort();
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const resource of unique) {
      releases.push(await acquireOneResourceLock(workspace, resource, command, options));
    }
    return await action();
  } finally {
    while (releases.length > 0) {
      const release = releases.pop();
      if (release) {
        await release();
      }
    }
  }
}

export async function withWorkspaceLock<T>(
  workspace: string,
  command: string,
  action: () => Promise<T>,
  options?: { waitMs?: number; staleMs?: number }
): Promise<T> {
  return withResourceLock(workspace, "workspace", command, action, options);
}
