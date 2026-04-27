import { loadConfig, tmuxSettings } from "../lib/config.js";
import { statePaths, ensureInitialized } from "../core/state.js";
import { execa } from "execa";
import { writeJson } from "../lib/fs.js";
import { probeTmux, tmuxBaseArgs, tmuxUnavailableStatus } from "../lib/platform.js";
import { iso, utcNow } from "../lib/time.js";
import { withResourceLocks } from "../lib/lock.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function cliEntryPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../index.js");
}

async function windowExists(tmux: string, baseArgs: string[], sessionName: string, windowName: string): Promise<boolean> {
  const listed = await execa(tmux, [...baseArgs, "list-windows", "-t", sessionName, "-F", "#{window_name}"], {
    reject: false,
    timeout: 5000,
  });
  if (listed.exitCode !== 0) {
    return false;
  }
  return (listed.stdout || "").split("\n").some((line) => line.trim() === windowName);
}

export async function cmdRunTmx(args: { config: string; poll_seconds?: number; pollSeconds?: number; restart?: boolean; once?: boolean }): Promise<void> {
  const config = loadConfig(args.config);
  await withResourceLocks(config.workspace, ["workspace", "runner", "tmux", "state"], "tns run-tmux", async () => {
    const paths = await ensureInitialized(config, { autoInit: true });
    const settings = tmuxSettings(config);

    if (!settings.enabled) {
      const status = {
        enabled: false,
        available: false,
        fallback: "direct",
        workspace: paths.workspace,
        updated_at: iso(utcNow()),
        reason: "tmux disabled in config",
      };
      await writeJson(paths.tmux, status);
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    const probe = await probeTmux(paths, settings);
    if (!probe.available || !probe.path) {
      const status = tmuxUnavailableStatus(paths, settings, probe.reason);
      await writeJson(paths.tmux, status);
      throw new Error(`tmux unavailable: ${probe.reason || "unknown reason"}`);
    }

    const resolvedTmux = probe.path;
    const baseArgs = tmuxBaseArgs(paths, settings);
    const sessionName = settings.session_name || `tns-${paths.workspace.split("/").pop()}`;
    const bootstrapWindowName = settings.window_name || "tns";
    const runnerWindowName = settings.runner_window_name || "tns-runner";
    const pollSeconds = Number(args.poll_seconds ?? args.pollSeconds ?? 60);
    const runnerCommand = [
      process.execPath,
      cliEntryPath(),
      "run",
      "--config",
      resolve(args.config),
      "--poll-seconds",
      String(pollSeconds),
      ...(args.once ? ["--once"] : []),
    ].map(shellQuote).join(" ");

    const hasSession = await execa(resolvedTmux, [...baseArgs, "has-session", "-t", sessionName], {
      reject: false,
      timeout: 5000,
    });

    if (hasSession.exitCode !== 0) {
      await execa(resolvedTmux, [...baseArgs, "new-session", "-d", "-s", sessionName, "-n", bootstrapWindowName, "-c", paths.workspace], {
        timeout: 5000,
      });
    }

    const targetWindow = runnerWindowName;
    const targetExists = await windowExists(resolvedTmux, baseArgs, sessionName, targetWindow);
    const target = `${sessionName}:${targetWindow}`;

    if (!targetExists) {
      await execa(resolvedTmux, [...baseArgs, "new-window", "-d", "-t", sessionName, "-n", targetWindow, "-c", paths.workspace, runnerCommand], {
        timeout: 5000,
      });
    } else if (args.restart) {
      await execa(resolvedTmux, [...baseArgs, "respawn-window", "-k", "-t", target, "-c", paths.workspace, runnerCommand], {
        timeout: 5000,
      });
    }

    const status = {
      enabled: true,
      available: true,
      session_name: sessionName,
      window_name: bootstrapWindowName,
      runner_window_name: runnerWindowName,
      workspace: paths.workspace,
      tmux_path: resolvedTmux,
      socket_path: probe.socket_path,
      updated_at: iso(utcNow()),
      manage_runner: true,
      poll_seconds: pollSeconds,
      launched: !targetExists || Boolean(args.restart),
      command: runnerCommand,
    };
    await writeJson(paths.tmux, status);
    console.log(JSON.stringify(status, null, 2));
  }, { waitMs: 2000 });
}
