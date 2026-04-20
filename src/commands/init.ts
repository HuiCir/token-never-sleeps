import { loadConfig } from "../lib/config.js";
import { initState } from "../core/state.js";

export async function cmdInit(args: { config: string }): Promise<void> {
  const config = loadConfig(args.config);
  await initState(config);
  console.log(`initialized TNS in ${config.workspace}/.tns`);
}