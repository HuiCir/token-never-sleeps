import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execa } from "execa";
import { buildSkillbaseIndex, matchSkillsFromIndex, resolveSkillFromIndex, skillbaseSettings, type SkillbaseEntry } from "../lib/skillbase.js";
import { configForWrite, loadConfig } from "../lib/config.js";
import { expandUser, writeJson } from "../lib/fs.js";
import type { ExternalSkillSpec, InjectionProfile, SkillbaseSourceSettings, TnsConfig } from "../types.js";

type SkillAction = "doctor" | "list" | "resolve" | "match" | "source-list" | "source-add" | "source-remove" | "install" | "uninstall" | "sync-check" | "registry-install" | "registry-update" | "registry-sync";
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
  package?: string;
  skill?: string[];
  agent?: string[];
  global?: boolean;
  project?: boolean;
  yes?: boolean;
  copy?: boolean;
  all?: boolean;
  bind?: boolean;
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

function addExternalSkill(config: TnsConfig, entry: SkillbaseEntry, purpose: string, registryPackage?: string): boolean {
  config.externals = {
    tools: config.externals?.tools ?? [],
    skills: config.externals?.skills ?? [],
    mcp: config.externals?.mcp ?? [],
  };
  const installedAt = new Date().toISOString();
  const spec: ExternalSkillSpec = {
    name: entry.name,
    required: true,
    purpose,
    source_id: entry.source_id,
    source_kind: entry.source_kind,
    source_path: entry.source_path,
    path: entry.path,
    content_hash: entry.content_hash,
    installed_at: installedAt,
    registry_package: registryPackage,
  };
  const existing = config.externals.skills?.find((item) => item.name === entry.name);
  if (existing) {
    Object.assign(existing, spec, { installed_at: existing.installed_at ?? installedAt });
    return false;
  }
  config.externals.skills = [
    ...(config.externals.skills ?? []),
    spec,
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

function stringList(values: string[] | undefined): string[] {
  return (values ?? []).map(String).filter(Boolean);
}

function stripAnsi(input: string): string {
  return input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function installedSkillSpecs(config: TnsConfig): ExternalSkillSpec[] {
  const byName = new Map<string, ExternalSkillSpec>();
  for (const skill of config.externals?.skills ?? []) {
    byName.set(skill.name, skill);
  }
  for (const skills of Object.values(installedSkillSummary(config))) {
    for (const name of skills) {
      if (name.startsWith("tns-")) {
        continue;
      }
      if (!byName.has(name)) {
        byName.set(name, { name, required: true, purpose: "installed in injection profile without recorded source metadata" });
      }
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function runSkillsCli(cliArgs: string[], cwd = process.cwd()): Promise<{ command: string[]; stdout: string; stderr: string }> {
  const command = ["npx", "--yes", "skills", ...cliArgs];
  const result = await execa(command[0], command.slice(1), {
    cwd,
    reject: false,
    all: false,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  if (result.exitCode !== 0) {
    throw new Error(`skills.sh command failed (${result.exitCode}): ${command.join(" ")}\n${result.stderr || result.stdout}`);
  }
  return { command, stdout: stripAnsi(result.stdout), stderr: stripAnsi(result.stderr) };
}

async function printSyncCheck(config: TnsConfig, args: SkillArgs): Promise<void> {
  const index = await buildSkillbaseIndex(config);
  const requested = args.name ? new Set([args.name]) : null;
  const installed = installedSkillSpecs(config).filter((item) => !requested || requested.has(item.name));
  const checks = installed.map((spec) => {
    const resolved = resolveSkillFromIndex(index, spec.name);
    const current = resolved.selected ?? null;
    const hashStatus = !current
      ? "missing"
      : !spec.content_hash
        ? "untracked"
        : spec.content_hash === current.content_hash
          ? "in_sync"
          : "changed";
    return {
      name: spec.name,
      status: hashStatus,
      installed_hash: spec.content_hash ?? null,
      current_hash: current?.content_hash ?? null,
      installed_source_id: spec.source_id ?? null,
      current_source_id: current?.source_id ?? null,
      installed_path: spec.path ?? null,
      current_path: current?.path ?? null,
      candidates: resolved.candidates.map((entry) => ({
        source_id: entry.source_id,
        path: entry.path,
        content_hash: entry.content_hash,
        priority: entry.priority,
      })),
    };
  });
  const summary = checks.reduce<Record<string, number>>((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(JSON.stringify({
    generated_at: index.generated_at,
    installed: installed.length,
    summary,
    checks,
  }, null, compact(args)));
}

async function bindResolvedSkills(config: TnsConfig, args: SkillArgs, names: string[], registryPackage?: string): Promise<{ bound: unknown[]; config?: string }> {
  if (names.length === 0 || args.bind === false) {
    return { bound: [] };
  }
  if (!config._config_path) {
    return { bound: names.map((name) => ({ name, bound: false, reason: "no resolved workspace config" })) };
  }
  const index = await buildSkillbaseIndex(config);
  const profile = profileNameFor(args);
  const bound = names.map((name) => {
    const resolved = resolveSkillFromIndex(index, name);
    if (!resolved.found || !resolved.selected) {
      return { name, bound: false, reason: "skill not found after registry operation" };
    }
    const installed = installSkillIntoProfile(config, profile, resolved.selected.name);
    const declared = addExternalSkill(config, resolved.selected, `installed from ${resolved.selected.source_id}`, registryPackage);
    return {
      name,
      bound: true,
      installed,
      declared_external: declared,
      selected: {
        name: resolved.selected.name,
        source_id: resolved.selected.source_id,
        path: resolved.selected.path,
        content_hash: resolved.selected.content_hash,
      },
    };
  });
  const configPath = await saveConfig(config, args);
  return { bound, config: configPath };
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
  const mutating = ["install", "uninstall", "source-add", "source-remove", "registry-install", "registry-update", "registry-sync"].includes(action);
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
    const declared = addExternalSkill(config, resolved.selected, `installed from skill source ${resolved.selected.source_id}`);
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

  if (action === "sync-check") {
    await printSyncCheck(config, args);
    return;
  }

  if (action === "registry-install") {
    const pkg = args.package ?? args.name;
    if (!pkg) throw new Error("tns skill registry-install requires a package, for example vercel-labs/agent-skills");
    const skillNames = stringList(args.skill);
    const cliArgs = ["add", pkg];
    if (args.global) cliArgs.push("--global");
    if (args.all) cliArgs.push("--all");
    if (args.copy) cliArgs.push("--copy");
    for (const agent of stringList(args.agent)) cliArgs.push("--agent", agent);
    for (const skill of skillNames) cliArgs.push("--skill", skill);
    if (args.yes !== false) cliArgs.push("--yes");
    const result = await runSkillsCli(cliArgs, config.workspace || process.cwd());
    const bound = await bindResolvedSkills(config, args, skillNames, pkg);
    console.log(JSON.stringify({
      registry: "skills.sh",
      command: result.command,
      stdout: result.stdout,
      stderr: result.stderr,
      ...bound,
    }, null, compact(args)));
    return;
  }

  if (action === "registry-update") {
    const names = args.name ? [args.name, ...stringList(args.skill)] : stringList(args.skill);
    const cliArgs = ["update", ...names];
    if (args.global) cliArgs.push("--global");
    if (args.project) cliArgs.push("--project");
    if (args.yes !== false) cliArgs.push("--yes");
    const result = await runSkillsCli(cliArgs, config.workspace || process.cwd());
    const refreshNames = names.length > 0 ? names : installedSkillSpecs(config).map((item) => item.name);
    const bound = await bindResolvedSkills(config, args, refreshNames);
    console.log(JSON.stringify({
      registry: "skills.sh",
      command: result.command,
      stdout: result.stdout,
      stderr: result.stderr,
      ...bound,
    }, null, compact(args)));
    return;
  }

  if (action === "registry-sync") {
    const cliArgs = ["experimental_sync"];
    for (const agent of stringList(args.agent)) cliArgs.push("--agent", agent);
    if (args.yes !== false) cliArgs.push("--yes");
    const result = await runSkillsCli(cliArgs, config.workspace || process.cwd());
    const bound = await bindResolvedSkills(config, args, installedSkillSpecs(config).map((item) => item.name));
    console.log(JSON.stringify({
      registry: "skills.sh",
      command: result.command,
      stdout: result.stdout,
      stderr: result.stderr,
      ...bound,
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
