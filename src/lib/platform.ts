import which from "which";
import type { StatePaths, TmuxSettings, TmuxStatus } from "../types.js";
import { iso, utcNow } from "./time.js";
import { execa } from "execa";
import { isAbsolute, resolve } from "node:path";

const whichSync = which.sync;

export function tmuxPath(): string | null {
  return whichSync("tmux", { nothrow: true }) || null;
}

export function tmuxSocketPath(paths: StatePaths, settings: TmuxSettings): string {
  if (!settings.socket_name) {
    return resolve(paths.state_dir, "tmux.sock");
  }
  if (isAbsolute(settings.socket_name)) {
    return settings.socket_name;
  }
  return resolve(paths.state_dir, settings.socket_name);
}

export function tmuxBaseArgs(paths: StatePaths, settings: TmuxSettings): string[] {
  return ["-S", tmuxSocketPath(paths, settings)];
}

export async function probeTmux(paths: StatePaths, settings: TmuxSettings): Promise<{ available: boolean; path: string | null; reason?: string; socket_path?: string }> {
  const resolved = tmuxPath();
  if (!resolved) {
    return { available: false, path: null, reason: "tmux not found in PATH" };
  }

  const socketPath = tmuxSocketPath(paths, settings);
  const probe = await execa(resolved, [...tmuxBaseArgs(paths, settings), "has-session", "-t", "__tns_probe__"], {
    reject: false,
    timeout: 5000,
  });
  const stderr = (probe.stderr || "").trim().toLowerCase();
  if (stderr.includes("operation not permitted") || stderr.includes("permission denied")) {
    return {
      available: false,
      path: resolved,
      reason: probe.stderr.trim() || "tmux socket is not usable",
      socket_path: socketPath,
    };
  }
  return {
    available: true,
    path: resolved,
    socket_path: socketPath,
  };
}

export function tmuxUnavailableStatus(paths: StatePaths, settings: TmuxSettings, reason?: string): TmuxStatus {
  return {
    enabled: settings.enabled,
    available: false,
    fallback: "direct",
    reason: reason || "tmux not found in PATH",
    workspace: paths.workspace,
    updated_at: iso(utcNow()),
    manage_runner: settings.manage_runner,
    runner_window_name: settings.runner_window_name,
    tmux_path: tmuxPath() || undefined,
  };
}
