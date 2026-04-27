import { rm } from "node:fs/promises";
import { loadConfig } from "../lib/config.js";
import { ensureInitialized, statePaths } from "../core/state.js";
import { clearRuntime, loadRuntime } from "../core/runtime.js";
import { pidIsAlive, readAllResourceLocks, readWorkspaceLock } from "../lib/lock.js";
import { appendJsonl, readJson, writeJson } from "../lib/fs.js";
import { recoverInProgressSections } from "../core/sections.js";
import type { Section } from "../types.js";
import { iso, utcNow } from "../lib/time.js";

export async function cmdRecover(args: { config: string; force?: boolean }): Promise<void> {
  const config = loadConfig(args.config);
  const paths = await ensureInitialized(config, { autoInit: false });
  const runtime = await loadRuntime(paths);
  const lock = await readWorkspaceLock(paths.workspace);
  const resourceLocks = await readAllResourceLocks(paths.workspace);
  const sections = (await readJson<Section[]>(paths.sections)) || [];

  let clearedRuntime = false;
  let clearedLock = false;
  const clearedResources: string[] = [];
  let recoveredSections = false;

  if (runtime && (!runtime.active || !pidIsAlive(runtime.pid) || args.force)) {
    await clearRuntime(paths);
    clearedRuntime = true;
  }

  if (lock && (!pidIsAlive(lock.pid) || args.force)) {
    await rm(`${paths.state_dir}/locks/workspace.lock`, { force: true });
    clearedLock = true;
  }

  for (const [name, info] of Object.entries(resourceLocks)) {
    if (!args.force && pidIsAlive(info.pid)) {
      continue;
    }
    await rm(`${paths.state_dir}/locks/${name}.lock`, { force: true });
    clearedResources.push(name);
  }

  if (recoverInProgressSections(sections)) {
    await writeJson(paths.sections, sections);
    recoveredSections = true;
  }

  await appendJsonl(paths.activity, {
    event: "manual_recover",
    at: iso(utcNow()),
    cleared_runtime: clearedRuntime,
    cleared_lock: clearedLock,
    cleared_resources: clearedResources,
    recovered_sections: recoveredSections,
    forced: Boolean(args.force),
  });

  console.log(JSON.stringify({
    workspace: paths.workspace,
    cleared_runtime: clearedRuntime,
    cleared_lock: clearedLock,
    cleared_resources: clearedResources,
    recovered_sections: recoveredSections,
  }, null, 2));
}
