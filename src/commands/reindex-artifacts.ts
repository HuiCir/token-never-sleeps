import { loadConfig } from "../lib/config.js";
import { statePaths } from "../core/state.js";
import { rebuildArtifactIndex } from "../core/artifacts.js";
import { withResourceLocks } from "../lib/lock.js";

export async function cmdReindexArtifacts(args: { config?: string }): Promise<void> {
  const config = loadConfig(args.config);
  await withResourceLocks(config.workspace, ["workspace", "artifacts", "state"], "tns reindex-artifacts", async () => {
    const artifacts = await rebuildArtifactIndex(statePaths(config));
    console.log(JSON.stringify(artifacts, null, 2));
  });
}
