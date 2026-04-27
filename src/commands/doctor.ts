import which from "which";
import { loadConfig, tmuxSettings } from "../lib/config.js";
import { ensureInitialized, loadManifest, statePaths } from "../core/state.js";
import { currentWindow } from "../lib/time.js";
import { probeTmux } from "../lib/platform.js";
import { runWorkspacePreflight } from "../core/validators.js";

export async function cmdDoctor(args: { config: string }): Promise<void> {
  const config = loadConfig(args.config);
  const paths = await ensureInitialized(config, { autoInit: false });
  const manifest = await loadManifest(paths);
  const preflight = await runWorkspacePreflight(paths, config);
  const tmux = await probeTmux(paths, tmuxSettings(config));

  console.log(JSON.stringify({
    workspace: paths.workspace,
    config_path: config._config_path ?? null,
    window: currentWindow(manifest),
    binaries: {
      node: which.sync("node", { nothrow: true }) || null,
      claude: which.sync("claude", { nothrow: true }) || null,
      tmux: which.sync("tmux", { nothrow: true }) || null,
    },
    tmux,
    preflight: {
      ok: preflight.every((item) => item.ok),
      results: preflight,
    },
  }, null, 2));
}
