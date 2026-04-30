import { buildSkillbaseIndex, resolveSkillFromIndex } from "../lib/skillbase.js";
import { loadConfig } from "../lib/config.js";
import type { TnsConfig } from "../types.js";

export async function cmdSkills(args: { config?: string; action?: string; name?: string; source?: string[]; compact?: boolean }): Promise<void> {
  const config = args.config
    ? loadConfig(args.config)
    : ({
        workspace: process.cwd(),
        product_doc: "",
        refresh_hours: 0,
        refresh_minutes: null,
        refresh_seconds: null,
        permission_mode: "default",
        effort: "medium",
        success_interval_seconds: 0,
        idle_interval_seconds: 0,
        max_budget_usd: null,
        tmux: {
          enabled: false,
          auto_create: false,
          session_name: "",
          window_name: "tns",
          socket_name: "",
          manage_runner: false,
          runner_window_name: "tns-runner",
        },
        workflow: { entry: "executor", max_steps_per_run: 1, agents: [] },
      } as TnsConfig);
  if (!args.config && args.source && args.source.length > 0) {
    config.skillbases = { use_default_sources: false, sources: [] };
  }
  if (args.source && args.source.length > 0) {
    config.skillbases = {
      ...(config.skillbases ?? {}),
      sources: [
        ...(config.skillbases?.sources ?? []),
        ...args.source.map((path, index) => ({
          id: `cli-${index + 1}`,
          path,
          kind: "auto" as const,
          priority: index,
        })),
      ],
    };
  }

  const action = args.action ?? "doctor";
  const index = await buildSkillbaseIndex(config);
  if (action === "resolve") {
    if (!args.name) {
      throw new Error("tns skills resolve requires --name");
    }
    const result = resolveSkillFromIndex(index, args.name);
    console.log(JSON.stringify({
      request: result.request,
      found: result.found,
      selected: result.selected ?? null,
      candidates: result.candidates,
    }, null, args.compact ? 0 : 2));
    return;
  }

  if (action === "list") {
    console.log(JSON.stringify({
      total: index.entries.length,
      unique: Object.keys(index.by_name).length,
      skills: Object.keys(index.by_name).sort(),
    }, null, args.compact ? 0 : 2));
    return;
  }

  if (action !== "doctor") {
    throw new Error(`unknown skills action: ${action}`);
  }

  console.log(JSON.stringify({
    generated_at: index.generated_at,
    sources: index.sources,
    total_entries: index.entries.length,
    unique_names: Object.keys(index.by_name).length,
    conflict_names: Object.keys(index.conflicts).length,
    conflicts: Object.fromEntries(Object.entries(index.conflicts)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 50)
      .map(([name, entries]) => [name, entries.map((entry) => ({
        path: entry.path,
        source_id: entry.source_id,
        priority: entry.priority,
        content_hash: entry.content_hash,
      }))])),
  }, null, args.compact ? 0 : 2));
}
