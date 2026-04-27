import { open, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

export interface WorkspaceLockInfo {
  pid: number;
  command: string;
  acquired_at: string;
  workspace: string;
}

const DEFAULT_STALE_MS = 30 * 60 * 1000;
const DEFAULT_WAIT_MS = 15 * 1000;
const POLL_MS = 200;

function lockPathForWorkspace(workspace: string): string {
  return resolve(workspace, ".tns", "workspace.lock");
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
  }
}

export async function readWorkspaceLock(workspace: string): Promise<WorkspaceLockInfo | null> {
  return readLockFile(lockPathForWorkspace(workspace));
}

export async function withWorkspaceLock<T>(
  workspace: string,
  command: string,
  action: () => Promise<T>,
  options?: { waitMs?: number; staleMs?: number }
): Promise<T> {
  const normalizedWorkspace = resolve(workspace);
  const lockPath = lockPathForWorkspace(normalizedWorkspace);
  const waitMs = options?.waitMs ?? DEFAULT_WAIT_MS;
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + waitMs;

  await mkdir(resolve(normalizedWorkspace, ".tns"), { recursive: true });

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      const info: WorkspaceLockInfo = {
        pid: process.pid,
        command,
        acquired_at: new Date().toISOString(),
        workspace: normalizedWorkspace,
      };
      await handle.writeFile(JSON.stringify(info, null, 2) + "\n", "utf-8");
      await handle.close();
      try {
        return await action();
      } finally {
        await rm(lockPath, { force: true });
      }
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }
      await removeIfStale(lockPath, staleMs);
      if (Date.now() >= deadline) {
        const holder = await readLockFile(lockPath);
        const suffix = holder
          ? ` lock held by pid ${holder.pid} running ${holder.command} since ${holder.acquired_at}`
          : " lock file still present";
        throw new Error(`workspace is busy:${suffix}`);
      }
      await sleep(POLL_MS);
    }
  }
}
