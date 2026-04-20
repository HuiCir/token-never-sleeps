import { loadConfig } from "../lib/config.js";
import { statePaths, ensureInitialized, loadManifest } from "../core/state.js";
import { readJson } from "../lib/fs.js";
import { currentWindow } from "../lib/time.js";
import { selectSection } from "../core/sections.js";
import { workflowSettings } from "../lib/config.js";
import type { Section } from "../types.js";

export async function cmdStatus(args: { config: string }): Promise<void> {
  const config = loadConfig(args.config);
  const paths = await ensureInitialized(config);
  const manifest = await loadManifest(paths);

  const sections = (await readJson<Section[]>(paths.sections)) || [];
  const counts: Record<string, number> = {};
  for (const s of sections) {
    counts[s.status] = (counts[s.status] || 0) + 1;
  }

  const window = currentWindow(manifest);
  const nextSection = selectSection(sections, 3);

  const status = {
    workspace: paths.workspace,
    window_index: window.index,
    window_start: window.start.toISOString(),
    window_end: window.end.toISOString(),
    freeze: await readJson(paths.freeze),
    counts,
    next_section: nextSection?.id || null,
    workflow: workflowSettings(config),
    tmux: await readJson(paths.tmux),
  };

  console.log(JSON.stringify(status, null, 2));
}