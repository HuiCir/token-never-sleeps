import { loadConfig, tmuxSettings } from "../lib/config.js";
import { cmdRun } from "./run.js";
import { cmdRunTmx } from "./run-tmux.js";
import { probeTmux } from "../lib/platform.js";
import { statePaths } from "../core/state.js";

export async function cmdStart(args: { config?: string; once?: boolean; poll_seconds?: number; pollSeconds?: number; restart?: boolean }): Promise<void> {
  const config = loadConfig(args.config);
  const settings = tmuxSettings(config);
  const paths = statePaths(config);
  const probe = settings.enabled ? await probeTmux(paths, settings) : { available: false };
  if (settings.enabled && settings.manage_runner && probe.available) {
    await cmdRunTmx(args);
    return;
  }
  if (settings.enabled && !probe.available) {
    console.error(`tmux is enabled in config but unavailable; starting direct runner. ${"reason" in probe && probe.reason ? `(${probe.reason})` : ""}`.trim());
  }
  await cmdRun(args);
}
