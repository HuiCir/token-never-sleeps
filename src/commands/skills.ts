import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildSkillbaseIndex, matchSkillsFromIndex, resolveSkillFromIndex, skillbaseSettings } from "../lib/skillbase.js";
import { configForWrite, loadConfig } from "../lib/config.js";
import { expandUser, writeJson } from "../lib/fs.js";
import type { ExternalSkillSpec, InjectionProfile, SkillbaseSourceSettings, TnsConfig } from "../types.js";

type SkillAction = "doctor" | "list" | "resolve" | "match" | "source-list" | "source-add" | "source-remove" | "install" | "uninstall";
type SourceKind = "auto" | "skillbase" | "plugin" | "skills_dir";
type SkillMode = "executor" | "verifier" | "compile";

interface SkillArgs {
  config?: string;
  action?: string;
  name?: string;
  source?: string[];
  path?: string;
  id?: string;
  kind?: SourceKind;
  priority?: number;
  profile?: string;
  mode?: SkillMode;
  text?: string;
  file?: string;
  limit?: number;
  compact?: boolean;
  disable_default_sources?: boolean;
  disableDefaultSources?: boolean;
}

function emptyCliConfig(): TnsConfig {
  return {
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
  } as TnsConfig;
}

function loadSkillConfig(args: SkillArgs, options?: { bindCliSources?: boolean }): TnsConfig {
  let config: TnsConfig;
  if (args.config) {
    config = loadConfig(args.config);
  } else {
    try {
      config = loadConfig();
    } catch {
      config = emptyCliConfig();
    }
  }
  if (!config._config_path && args.source && args.source.length > 0) {
    config.skillbases = { use_default_sources: false, sources: [] };
  }
  if (options?.bindCliSources ?? true) {
    bindCliSources(config, args.source);
  }
  return config;
}

function bindCliSources(config: TnsConfig, sources: string[] | undefined): void {
  if (sources && sources.length > 0) {
    config.skillbases = {
      ...(config.skillbases ?? {}),
      sources: [
        ...(config.skillbases?.sources ?? []),
        ...sources.map((path, index) => ({
          id: `cli-${index + 1}`,
          path,
          kind: "auto" as const,
          priority: index,
        })),
      ],
    };
  }
}

function serializableConfig(config: TnsConfig): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  delete clone._config_path;
  delete clone._program_from_compiled;
  return clone;
}

async function saveConfig(config: TnsConfig, args: SkillArgs): Promise<string> {
  const configPath = config._config_path || args.config;
  if (!configPath) {
    throw new Error("this skill action requires --config so TNS can persist the binding");
  }
  await writeJson(configPath, configForWrite(serializableConfig(config), configPath));
  return configPath;
}

function compact(args: SkillArgs): number {
  return args.compact ? 0 : 2;
}

function ensureSkillbases(config: TnsConfig): NonNullable<TnsConfig["skillbases"]> {
  config.skillbases = {
    use_default_sources: config.skillbases?.use_default_sources ?? true,
    sources: config.skillbases?.sources ?? [],
    selection: config.skillbases?.selection,
  };
  return config.skillbases;
}

function normalizeSourcePath(path: string): string {
  return resolve(expandUser(path));
}

function sourceIdFromPath(path: string): string {
  return normalizeSourcePath(path).split("/").filter(Boolean).pop()?.replace(/[^A-Za-z0-9_-]/g, "-") || "skill-source";
}

function sourceSpec(args: SkillArgs, path: string, index: number): SkillbaseSourceSettings {
  return {
    id: args.id || sourceIdFromPath(path),
    path: normalizeSourcePath(path),
    kind: args.kind ?? "auto",
    priority: Number(args.priority ?? index),
  };
}

function addSource(config: TnsConfig, source: SkillbaseSourceSettings): { added: boolean; source: SkillbaseSourceSettings } {
  const skillbases = ensureSkillbases(config);
  const sources = skillbases.sources ?? [];
  const normalizedPath = normalizeSourcePath(source.path);
  const existing = sources.find((item) =>
    item.id === source.id || normalizeSourcePath(item.path) === normalizedPath
  );
  if (existing) {
    Object.assign(existing, {
      ...existing,
      ...source,
      path: normalizeSourcePath(source.path),
    });
    return { added: false, source: existing };
  }
  const next = { ...source, path: normalizedPath };
  sources.push(next);
  skillbases.sources = sources;
  return { added: true, source: next };
}

function removeSource(config: TnsConfig, key: string): { removed: SkillbaseSourceSettings[] } {
  const skillbases = ensureSkillbases(config);
  const sources = skillbases.sources ?? [];
  const normalizedKey = key.includes("/") ? normalizeSourcePath(key) : key;
  const kept: SkillbaseSourceSettings[] = [];
  const removed: SkillbaseSourceSettings[] = [];
  for (const source of sources) {
    const matches = source.id === key || normalizeSourcePath(source.path) === normalizedKey;
    if (matches) {
      removed.push(source);
    } else {
      kept.push(source);
    }
  }
  skillbases.sources = kept;
  return { removed };
}

function profileNameFor(args: SkillArgs): string {
  if (args.profile) return args.profile;
  const mode = args.mode ?? "executor";
  if (mode === "verifier") return "verifier_audit";
  if (mode === "compile") return "compiler";
  return "executor_task";
}

function ensureInjectionProfile(config: TnsConfig, name: string): InjectionProfile {
  config.injections = {
    default_profile: config.injections?.default_profile ?? null,
    profiles: config.injections?.profiles ?? {},
    rules: config.injections?.rules ?? [],
  };
  config.injections.profiles[name] = {
    skills: [],
    external_skill_paths: [],
    add_dirs: [],
    ...(config.injections.profiles[name] ?? {}),
  };
  return config.injections.profiles[name];
}

function installSkillIntoProfile(config: TnsConfig, profileName: string, skillName: string): boolean {
  const profile = ensureInjectionProfile(config, profileName);
  const skills = Array.from(new Set([...(profile.skills ?? []), skillName]));
  const changed = skills.length !== (profile.skills ?? []).length;
  profile.skills = skills;
  return changed;
}

function uninstallSkillFromProfile(config: TnsConfig, profileName: string, skillName: string): boolean {
  const profile = ensureInjectionProfile(config, profileName);
  const previous = profile.skills ?? [];
  const next = previous.filter((item) => item !== skillName);
  profile.skills = next;
  return next.length !== previous.length;
}

function addExternalSkill(config: TnsConfig, skillName: string, purpose: string): boolean {
  config.externals = {
    tools: config.externals?.tools ?? [],
    skills: config.externals?.skills ?? [],
    mcp: config.externals?.mcp ?? [],
  };
  const existing = config.externals.skills?.find((item) => item.name === skillName);
  if (existing) {
    return false;
  }
  config.externals.skills = [
    ...(config.externals.skills ?? []),
    { name: skillName, required: true, purpose } satisfies ExternalSkillSpec,
  ];
  return true;
}

function removeExternalSkill(config: TnsConfig, skillName: string): boolean {
  config.externals = {
    tools: config.externals?.tools ?? [],
    skills: config.externals?.skills ?? [],
    mcp: config.externals?.mcp ?? [],
  };
  const previous = config.externals.skills ?? [];
  const next = previous.filter((item) => item.name !== skillName);
  config.externals.skills = next;
  return next.length !== previous.length;
}

function installedSkillSummary(config: TnsConfig): Record<string, string[]> {
  const profiles = config.injections?.profiles ?? {};
  return Object.fromEntries(Object.entries(profiles)
    .map(([name, profile]) => [name, Array.from(new Set(profile.skills ?? [])).sort()])
    .filter(([, skills]) => skills.length > 0));
}

async function printReadonlySkillAction(config: TnsConfig, args: SkillArgs, action: SkillAction): Promise<void> {
  const index = await buildSkillbaseIndex(config);

  if (action === "resolve") {
    if (!args.name) {
      throw new Error("tns skill resolve requires a skill name");
    }
    const result = resolveSkillFromIndex(index, args.name);
    console.log(JSON.stringify({
      request: result.request,
      found: result.found,
      selected: result.selected ?? null,
      candidates: result.candidates,
    }, null, compact(args)));
    return;
  }

  if (action === "match") {
    const text = args.text ?? (args.file ? await readFile(args.file, "utf-8") : "");
    if (!text.trim()) {
      throw new Error("tns skill match requires --text or --file");
    }
    const matches = matchSkillsFromIndex(index, text, {
      max: args.limit ?? config.skillbases?.selection?.max_matches_per_section ?? 5,
      minScore: config.skillbases?.selection?.min_score ?? 0.22,
    });
    console.log(JSON.stringify({
      query_length: text.length,
      matches: matches.map((match) => ({
        name: match.name,
        score: match.score,
        path: match.entry.path,
        source_id: match.entry.source_id,
        matched_terms: match.matched_terms,
        description: match.entry.description,
      })),
    }, null, compact(args)));
    return;
  }

  if (action === "list") {
    console.log(JSON.stringify({
      total: index.entries.length,
      unique: Object.keys(index.by_name).length,
      skills: Object.keys(index.by_name).sort(),
      installed: installedSkillSummary(config),
    }, null, compact(args)));
    return;
  }

  if (action === "source-list") {
    console.log(JSON.stringify({
      configured_sources: config.skillbases?.sources ?? [],
      effective_sources: skillbaseSettings(config).sources,
      scanned_sources: index.sources,
    }, null, compact(args)));
    return;
  }

  if (action !== "doctor") {
    throw new Error(`readonly skill action not supported: ${action}`);
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
    installed: installedSkillSummary(config),
  }, null, compact(args)));
}

export async function cmdSkill(args: SkillArgs): Promise<void> {
  const action = (args.action ?? "doctor") as SkillAction;
  const mutating = ["install", "uninstall", "source-add", "source-remove"].includes(action);
  const config = loadSkillConfig(args, { bindCliSources: !mutating });

  if (action === "source-add") {
    if (!config._config_path) throw new Error("tns skill source-add requires a resolved workspace config");
    const paths = args.source && args.source.length > 0 ? args.source : (args.path ? [args.path] : []);
    if (paths.length === 0) throw new Error("tns skill source-add requires --source or --path");
    if (args.disable_default_sources ?? args.disableDefaultSources) {
      ensureSkillbases(config).use_default_sources = false;
    }
    const results = paths.map((path, index) => addSource(config, sourceSpec(args, path, index)));
    const configPath = await saveConfig(config, args);
    console.log(JSON.stringify({
      config: configPath,
      sources: results,
    }, null, compact(args)));
    return;
  }

  if (action === "source-remove") {
    if (!config._config_path) throw new Error("tns skill source-remove requires a resolved workspace config");
    const key = args.name ?? args.id ?? args.path;
    if (!key) throw new Error("tns skill source-remove requires a source id or path");
    const result = removeSource(config, key);
    const configPath = await saveConfig(config, args);
    console.log(JSON.stringify({
      config: configPath,
      removed: result.removed,
    }, null, compact(args)));
    return;
  }

  if (action === "install") {
    if (!config._config_path) throw new Error("tns skill install requires a resolved workspace config");
    if (!args.name) throw new Error("tns skill install requires a skill name");
    const boundSources = (args.source ?? []).map((path, index) => addSource(config, sourceSpec(args, path, index)));
    const index = await buildSkillbaseIndex(config);
    const resolved = resolveSkillFromIndex(index, args.name);
    if (!resolved.found || !resolved.selected) {
      throw new Error(`skill not found: ${args.name}`);
    }
    const profile = profileNameFor(args);
    const installed = installSkillIntoProfile(config, profile, resolved.selected.name);
    const declared = addExternalSkill(config, resolved.selected.name, `installed from skill source ${resolved.selected.source_id}`);
    const configPath = await saveConfig(config, args);
    console.log(JSON.stringify({
      config: configPath,
      installed,
      declared_external: declared,
      profile,
      skill: {
        requested: args.name,
        name: resolved.selected.name,
        path: resolved.selected.path,
        source_id: resolved.selected.source_id,
        source_kind: resolved.selected.source_kind,
      },
      bound_sources: boundSources,
    }, null, compact(args)));
    return;
  }

  if (action === "uninstall") {
    if (!config._config_path) throw new Error("tns skill uninstall requires a resolved workspace config");
    if (!args.name) throw new Error("tns skill uninstall requires a skill name");
    const profile = profileNameFor(args);
    const uninstalled = uninstallSkillFromProfile(config, profile, args.name);
    const undeclared = removeExternalSkill(config, args.name);
    const configPath = await saveConfig(config, args);
    console.log(JSON.stringify({
      config: configPath,
      uninstalled,
      undeclared_external: undeclared,
      profile,
      skill: args.name,
    }, null, compact(args)));
    return;
  }

  await printReadonlySkillAction(config, args, action);
}

export async function cmdSkills(args: SkillArgs): Promise<void> {
  const action = (args.action ?? "doctor") as SkillAction;
  if (["install", "uninstall", "source-add", "source-remove"].includes(action)) {
    throw new Error(`tns skills --action ${action} is not supported; use 'tns skill ${action}'`);
  }
  await printReadonlySkillAction(loadSkillConfig(args, { bindCliSources: true }), args, action);
}
