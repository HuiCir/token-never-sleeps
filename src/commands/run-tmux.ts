import { loadConfig, tmuxSettings } from "../lib/config.js";
import { statePaths, ensureInitialized } from "../core/state.js";
import { execa } from "execa";
import which from "which";
const whichSync = which.sync;

export async function cmdRunTmx(args: { config: string; poll_seconds?: number; restart?: boolean }): Promise<void> {
  const config = loadConfig(args.config);
  const paths = await ensureInitialized(config);
  const settings = tmuxSettings(config);

  if (!settings.enabled) {
    console.log(JSON.stringify({ error: "tmux not enabled in config" }, null, 2));
    return;
  }

  const tmuxPath: string = whichSync("tmux");
  if (!tmuxPath) {
    throw new Error("tmux not found in PATH");
  }

  const sessionName: string = settings.session_name || `tns-${paths.workspace.split("/").pop()}`;
  const windowName: string = settings.window_name;

  // Check if session exists
  let hasSession = false;
  try {
    const check = await execa(tmuxPath, ["has-session", "-t", sessionName]).catch(() => ({ exitCode: -1 }));
    hasSession = check.exitCode === 0;
  } catch {
    hasSession = false;
  }

  if (!hasSession) {
    await execa(tmuxPath, ["new-session", "-d", "-s", sessionName, "-n", windowName, "-c", paths.workspace]);
  }

  console.log(JSON.stringify({
    session_name: sessionName,
    window_name: windowName,
    workspace: paths.workspace,
    tmux_path: tmuxPath,
  }, null, 2));
}
