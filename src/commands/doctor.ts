import which from "which";
import { agentProviderSettings, loadConfig, tmuxSettings } from "../lib/config.js";
import { ensureInitialized, loadManifest, statePaths } from "../core/state.js";
import { currentWindow } from "../lib/time.js";
import { probeTmux } from "../lib/platform.js";
import { runWorkspacePreflight } from "../core/validators.js";

export async function cmdDoctor(args: { config?: string }): Promise<void> {
  const config = loadConfig(args.config);
  const paths = await ensureInitialized(config, { autoInit: false });
  const manifest = await loadManifest(paths);
  const preflight = await runWorkspacePreflight(paths, config);
  const tmux = await probeTmux(paths, tmuxSettings(config));
  const agentProvider = agentProviderSettings(config);
  const binaries: Record<string, string | null> = {
    node: which.sync("node", { nothrow: true }) || null,
    claude: which.sync("claude", { nothrow: true }) || null,
    tmux: which.sync("tmux", { nothrow: true }) || null,
  };
  if (agentProvider.name === "codex") {
    binaries.codex = which.sync("codex", { nothrow: true }) || null;
  }

  console.log(JSON.stringify({
    workspace: paths.workspace,
    config_path: config._config_path ?? null,
    agent_provider: {
      name: agentProvider.name,
      command: agentProvider.command,
      model: agentProvider.model || null,
      profile: agentProvider.profile || null,
    },
    window: currentWindow(manifest),
    binaries,
    tmux,
    preflight: {
      ok: preflight.every((item) => item.ok),
      results: preflight,
    },
  }, null, 2));
}
