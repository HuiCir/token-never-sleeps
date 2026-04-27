import { loadConfig } from "../lib/config.js";
import { statePaths, ensureInitialized, loadManifest } from "../core/state.js";
import { writeJson, appendJsonl, pathExists } from "../lib/fs.js";
import { iso, utcNow, currentWindow } from "../lib/time.js";
import type { FreezeRecord } from "../types.js";
import { withWorkspaceLock } from "../lib/lock.js";

export async function cmdFreeze(args: { config: string; reason?: string }): Promise<void> {
  const config = loadConfig(args.config);
  await withWorkspaceLock(config.workspace, "tns freeze", async () => {
    const paths = await ensureInitialized(config);
    const manifest = await loadManifest(paths);

    const window = currentWindow(manifest);
    const until = window.end;

    const freezeRecord: FreezeRecord = {
      reason: args.reason || "manual freeze",
      at: iso(utcNow()),
      until: until.toISOString(),
      window: window.index,
    };

    await writeJson(paths.freeze, freezeRecord);
    await appendJsonl(paths.activity, { event: "freeze", ...freezeRecord });
    console.log(JSON.stringify(freezeRecord, null, 2));
  });
}

export async function cmdUnfreeze(args: { config: string }): Promise<void> {
  const config = loadConfig(args.config);
  await withWorkspaceLock(config.workspace, "tns unfreeze", async () => {
    const paths = await ensureInitialized(config);
    const { appendJsonl: appendJ, pathExists: exists } = await import("../lib/fs.js");
    if (await exists(paths.freeze)) {
      const { unlink } = await import("node:fs/promises");
      await unlink(paths.freeze);
    }
    await appendJ(paths.activity, { event: "manual_unfreeze", at: iso(utcNow()) });
    console.log("unfrozen");
  });
}
