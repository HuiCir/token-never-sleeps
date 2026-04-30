import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { expandUser, pathExists } from "./fs.js";
import type { SkillbaseSelectionSettings, SkillbaseSettings, SkillbaseSourceSettings, TnsConfig } from "../types.js";

export interface SkillbaseEntry {
  name: string;
  description: string;
  path: string;
  skill_file: string;
  source_id: string;
  source_kind: "skillbase" | "plugin" | "skills_dir";
  source_path: string;
  priority: number;
  content_hash: string;
  directory_name: string;
  search_text?: string;
}

export interface SkillbaseIndex {
  generated_at: string;
  sources: Array<{
    id: string;
    path: string;
    kind: "skillbase" | "plugin" | "skills_dir";
    priority: number;
    exists: boolean;
    entries: number;
  }>;
  entries: SkillbaseEntry[];
  by_name: Record<string, SkillbaseEntry[]>;
  conflicts: Record<string, SkillbaseEntry[]>;
}

export interface SkillResolution {
  request: string;
  found: boolean;
  selected?: SkillbaseEntry;
  candidates: SkillbaseEntry[];
}

export interface SkillMatch {
  name: string;
  score: number;
  entry: SkillbaseEntry;
  matched_terms: string[];
}

interface ParsedSkillMarkdown {
  name: string;
  description: string;
}

interface NormalizedSource {
  id: string;
  path: string;
  kind: "auto" | "skillbase" | "plugin" | "skills_dir";
  priority: number;
}

function defaultSourcePaths(): SkillbaseSourceSettings[] {
  return [
    { id: "agents-skills", path: "~/.agents/skills", kind: "skills_dir", priority: 100 },
    { id: "codex-user-skills", path: "~/.codex/skills", kind: "skills_dir", priority: 110 },
    { id: "codex-plugin-library", path: "~/.codex/.tmp/plugins", kind: "plugin", priority: 200 },
  ];
}

export function skillbaseSettings(config: TnsConfig): Required<SkillbaseSettings> {
  const cfg = config.skillbases ?? {};
  const useDefault = cfg.use_default_sources ?? true;
  const envSources = (process.env.TNS_SKILLBASE_PATHS ?? "")
    .split(":")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((path, index) => ({ id: `env-${index + 1}`, path, kind: "auto" as const, priority: 50 + index }));
  return {
    use_default_sources: useDefault,
    sources: [
      ...envSources,
      ...(useDefault ? defaultSourcePaths() : []),
      ...(cfg.sources ?? []),
    ],
    selection: skillbaseSelectionSettings(config),
  };
}

export function skillbaseSelectionSettings(config: TnsConfig): Required<SkillbaseSelectionSettings> {
  const cfg = config.skillbases?.selection ?? {};
  return {
    mode: cfg.mode ?? "explicit",
    max_matches_per_section: Math.max(1, Number(cfg.max_matches_per_section ?? 2)),
    min_score: Math.max(0, Number(cfg.min_score ?? 0.22)),
    verifier_mode: cfg.verifier_mode ?? "none",
  };
}

function normalizeSkillName(input: string): string {
  return input.trim().replace(/^import\s+/, "").split(/\s+as\s+/i)[0].trim();
}

function skillAliases(input: string): string[] {
  const normalized = normalizeSkillName(input).toLowerCase();
  return Array.from(new Set([
    normalized,
    normalized.replace(/_/g, "-"),
    normalized.replace(/-/g, "_"),
  ]));
}

function primaryNameFromDirectory(path: string): string {
  const dir = basename(path);
  return dir.replace(/__[A-Za-z0-9_-]+$/, "");
}

function parseFrontmatterValue(frontmatter: string, key: string): string | null {
  const pattern = new RegExp(`^${key}:\\s*(.*)$`, "m");
  const match = frontmatter.match(pattern);
  if (!match) return null;
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

function parseSkillMarkdown(content: string, fallbackName: string): ParsedSkillMarkdown {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  const frontmatter = match?.[1] ?? "";
  return {
    name: parseFrontmatterValue(frontmatter, "name") || fallbackName,
    description: parseFrontmatterValue(frontmatter, "description") || "",
  };
}

function shortHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

async function readSkillFile(skillFile: string, source: NormalizedSource, sourceKind: "skillbase" | "plugin" | "skills_dir"): Promise<SkillbaseEntry | null> {
  try {
    const content = await readFile(skillFile, "utf-8");
    const skillDir = dirname(skillFile);
    const parsed = parseSkillMarkdown(content, primaryNameFromDirectory(skillDir));
    const entry: SkillbaseEntry = {
      name: parsed.name,
      description: parsed.description,
      path: skillDir,
      skill_file: skillFile,
      source_id: source.id,
      source_kind: sourceKind,
      source_path: source.path,
      priority: source.priority,
      content_hash: shortHash(content),
      directory_name: basename(skillDir),
    };
    Object.defineProperty(entry, "search_text", {
      value: content,
      enumerable: false,
    });
    return entry;
  } catch {
    return null;
  }
}

async function scanForSkillFiles(root: string, maxDepth: number): Promise<string[]> {
  const results: string[] = [];
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      results.push(join(current, "SKILL.md"));
      return;
    }
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith("."))
      .map((entry) => walk(join(current, entry.name), depth + 1)));
  }
  await walk(root, 0);
  return results;
}

async function sourceKind(path: string, requested: NormalizedSource["kind"]): Promise<"skillbase" | "plugin" | "skills_dir"> {
  if (requested !== "auto") return requested;
  if (await pathExists(join(path, "index.json")) && await pathExists(join(path, "skills"))) {
    return "skillbase";
  }
  if (await pathExists(join(path, "plugins")) || await pathExists(join(path, ".agents", "skills"))) {
    return "plugin";
  }
  return "skills_dir";
}

async function scanSource(source: NormalizedSource): Promise<{ source: SkillbaseIndex["sources"][number]; entries: SkillbaseEntry[] }> {
  const root = resolve(expandUser(source.path));
  const exists = await pathExists(root);
  if (!exists) {
    return { source: { id: source.id, path: root, kind: "skills_dir", priority: source.priority, exists: false, entries: 0 }, entries: [] };
  }
  const kind = await sourceKind(root, source.kind);
  const skillFiles = kind === "skillbase"
    ? await scanForSkillFiles(join(root, "skills"), 2)
    : await scanForSkillFiles(root, kind === "plugin" ? 6 : 2);
  const entries = (await Promise.all(skillFiles.map((file) => readSkillFile(file, { ...source, path: root }, kind))))
    .filter((entry): entry is SkillbaseEntry => entry !== null);
  return {
    source: { id: source.id, path: root, kind, priority: source.priority, exists: true, entries: entries.length },
    entries,
  };
}

function normalizeSources(settings: SkillbaseSettings): NormalizedSource[] {
  return (settings.sources ?? [])
    .filter((source) => source.enabled !== false && source.path)
    .map((source, index) => ({
      id: source.id || `skillbase-${index + 1}`,
      path: source.path,
      kind: source.kind ?? "auto",
      priority: Number(source.priority ?? 1000 + index),
    }));
}

export async function buildSkillbaseIndex(config: TnsConfig): Promise<SkillbaseIndex> {
  const settings = skillbaseSettings(config);
  const sources = normalizeSources(settings);
  const scanned = await Promise.all(sources.map(scanSource));
  const entries = scanned
    .flatMap((item) => item.entries)
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  const byName: Record<string, SkillbaseEntry[]> = {};
  for (const entry of entries) {
    const key = entry.name;
    byName[key] = [...(byName[key] ?? []), entry];
  }
  const conflicts = Object.fromEntries(Object.entries(byName).filter(([, items]) => items.length > 1));
  return {
    generated_at: new Date().toISOString(),
    sources: scanned.map((item) => item.source),
    entries,
    by_name: byName,
    conflicts,
  };
}

export function resolveSkillFromIndex(index: SkillbaseIndex, request: string): SkillResolution {
  const names = skillAliases(request);
  const direct = names.flatMap((name) => index.by_name[name] ?? []);
  if (direct.length > 0) {
    return { request, found: true, selected: direct[0], candidates: direct };
  }
  const loose = index.entries.filter((entry) => {
    const directoryNames = skillAliases(entry.directory_name);
    const primaryNames = skillAliases(primaryNameFromDirectory(entry.directory_name));
    return names.some((name) => directoryNames.includes(name) || primaryNames.includes(name));
  });
  return { request, found: loose.length > 0, selected: loose[0], candidates: loose };
}

export async function resolveSkill(config: TnsConfig, request: string): Promise<SkillResolution> {
  return resolveSkillFromIndex(await buildSkillbaseIndex(config), request);
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "task", "create", "write",
  "output", "file", "section", "using", "need", "needs", "should", "will", "make", "build",
  "extract", "generate", "analyze", "analysis", "report", "data", "document", "documents",
]);

function tokenize(input: string): string[] {
  return Array.from(new Set(input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .flatMap((item) => tokenVariants(item))
    .map((item) => item.trim())
    .filter((item) => item.length >= 3 && !STOPWORDS.has(item))));
}

function tokenVariants(input: string): string[] {
  const variants = [input];
  if (input.endsWith("ies") && input.length > 5) {
    variants.push(`${input.slice(0, -3)}y`);
  }
  if (input.endsWith("ing") && input.length > 6) {
    variants.push(input.slice(0, -3));
  }
  if (input.endsWith("ed") && input.length > 5) {
    variants.push(input.slice(0, -2));
  }
  if (input.endsWith("es") && input.length > 5) {
    variants.push(input.slice(0, -2));
  }
  if (input.endsWith("s") && input.length > 4) {
    variants.push(input.slice(0, -1));
  }
  return variants;
}

function entryMetadataText(entry: SkillbaseEntry): string {
  return [
    entry.name,
    entry.directory_name,
    primaryNameFromDirectory(entry.directory_name),
    entry.description,
  ].join(" ");
}

function scoreEntry(queryText: string, queryTokens: string[], entry: SkillbaseEntry): SkillMatch | null {
  if (queryTokens.length === 0) {
    return null;
  }
  const metadataTokenSet = new Set(tokenize(entryMetadataText(entry)));
  const bodyTokenSet = new Set(tokenize(entry.search_text ?? ""));
  const metadataMatchedTerms = queryTokens.filter((token) => metadataTokenSet.has(token));
  const bodyMatchedTerms = queryTokens.filter((token) => !metadataTokenSet.has(token) && bodyTokenSet.has(token));
  const matchedTerms = [...metadataMatchedTerms, ...bodyMatchedTerms.slice(0, 12)];
  const aliases = skillAliases(entry.name).flatMap((name) => [name, name.replace(/[_-]/g, " ")]);
  const aliasHit = aliases.some((alias) => alias.length >= 3 && queryText.toLowerCase().includes(alias));
  const directoryHit = skillAliases(primaryNameFromDirectory(entry.directory_name))
    .some((alias) => alias.length >= 3 && queryText.toLowerCase().includes(alias));
  const signal = Math.min(1, metadataMatchedTerms.length / 3);
  const overlap = metadataMatchedTerms.length / Math.max(1, Math.sqrt(queryTokens.length) * 4);
  const bodySupport = metadataMatchedTerms.length > 0
    ? Math.min(0.15, bodyMatchedTerms.length / Math.max(1, Math.sqrt(queryTokens.length) * 20))
    : 0;
  const score = signal + overlap + bodySupport + (aliasHit ? 0.75 : 0) + (directoryHit ? 0.35 : 0);
  if (score <= 0) {
    return null;
  }
  return {
    name: entry.name,
    score: Number(score.toFixed(4)),
    entry,
    matched_terms: matchedTerms,
  };
}

export function matchSkillsFromIndex(index: SkillbaseIndex, text: string, options?: { max?: number; minScore?: number }): SkillMatch[] {
  const queryTokens = tokenize(text);
  const max = Math.max(1, Number(options?.max ?? 2));
  const minScore = Math.max(0, Number(options?.minScore ?? 0.22));
  const byName = new Map<string, SkillMatch>();
  for (const entry of index.entries) {
    const match = scoreEntry(text, queryTokens, entry);
    if (!match || match.score < minScore) {
      continue;
    }
    const current = byName.get(match.name);
    if (!current || match.score > current.score || (match.score === current.score && entry.priority < current.entry.priority)) {
      byName.set(match.name, match);
    }
  }
  return Array.from(byName.values())
    .sort((a, b) => b.score - a.score || a.entry.priority - b.entry.priority || a.name.localeCompare(b.name))
    .slice(0, max);
}

export async function matchSkills(config: TnsConfig, text: string, options?: { max?: number; minScore?: number }): Promise<SkillMatch[]> {
  return matchSkillsFromIndex(await buildSkillbaseIndex(config), text, options);
}

export async function localSkillExists(path: string): Promise<boolean> {
  try {
    const info = await stat(join(path, "SKILL.md"));
    return info.isFile();
  } catch {
    return false;
  }
}
