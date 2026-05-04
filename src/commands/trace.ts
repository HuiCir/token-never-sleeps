import { readdir, readFile } from "node:fs/promises";
import { loadConfig } from "../lib/config.js";
import { ensureInitialized } from "../core/state.js";
import type { ActivityEvent } from "../types.js";

export async function cmdTrace(args: { config?: string; section?: string; limit?: number }): Promise<void> {
  const config = loadConfig(args.config);
  const paths = await ensureInitialized(config, { autoInit: false });
  const limit = Math.max(1, Number(args.limit ?? 30));
  let events: ActivityEvent[] = [];
  try {
    const content = await readFile(paths.activity, "utf-8");
    events = content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ActivityEvent);
  } catch {
    events = [];
  }
  if (args.section) {
    events = events.filter((event) => event.section === args.section);
  }
  const readTail = async (path: string) => {
    try {
      const content = await readFile(path, "utf-8");
      const rows = content
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      return rows.slice(Math.max(rows.length - limit, 0));
    } catch {
      return [];
    }
  };
  const recentAgentRuns = async () => {
    try {
      const files = (await readdir(paths.agent_runs_dir))
        .filter((name) => name.endsWith(".json"))
        .sort()
        .slice(-limit);
      const rows = [];
      for (const name of files) {
        const raw = JSON.parse(await readFile(`${paths.agent_runs_dir}/${name}`, "utf-8")) as Record<string, unknown>;
        rows.push({
          run_id: raw.run_id,
          at: raw.at,
          agent: raw.agent,
          mode: raw.mode,
          section_id: raw.section_id,
          step: raw.step,
          injection_profile: raw.injection_profile,
          injected_skills: raw.injected_skills,
        });
      }
      return rows;
    } catch {
      return [];
    }
  };
  console.log(JSON.stringify({
    workspace: paths.workspace,
    total: events.length,
    events: events.slice(Math.max(events.length - limit, 0)),
    lock_events: await readTail(paths.lock_events),
    tool_events: await readTail(paths.tool_events),
    hook_events: await readTail(paths.hook_events),
    injection_events: await readTail(paths.injection_events),
    agent_runs: await recentAgentRuns(),
  }, null, 2));
}
