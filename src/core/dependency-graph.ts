import type { Section } from "../types.js";

export interface SectionDependencyGraph {
  dependencies: Record<string, string[]>;
  produced_files: Record<string, string[]>;
  referenced_files: Record<string, string[]>;
  notes: string[];
}

type SectionLike = Pick<Section, "id" | "title" | "body">;

const DEPENDENCY_LINE = /^\s*(?:depends\s+on|depends\s+upon|dependencies|requires|after|\u4f9d\u8d56|\u53d6\u51b3\u4e8e)\s*[:\uff1a]\s*(.+?)\s*$/i;
const FILE_PATH = /`([^`\n]+\.[A-Za-z0-9][A-Za-z0-9._-]{0,15})`/g;
const CREATE_LINE = /^\s*(?:(?:create|write|produce|generate|save|emit|output)\b|\u751f\u6210|\u521b\u5efa|\u5199\u5165)/i;

function normalizeToken(input: string): string {
  return input
    .toLowerCase()
    .replace(/[`"'\u201c\u201d\u2018\u2019]/g, "")
    .replace(/\bsection\s+\d+\s*[:.-]\s*/i, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function sectionAliases(section: SectionLike): string[] {
  const title = normalizeToken(section.title);
  const withoutNumber = title.replace(/^(?:section\s*)?\d+\s*/, "").trim();
  return unique([normalizeToken(section.id), section.id.toLowerCase(), title, withoutNumber]);
}

function extractFilePaths(text: string): string[] {
  const files: string[] = [];
  for (const match of text.matchAll(FILE_PATH)) {
    files.push(match[1].trim());
  }
  return unique(files);
}

function producedFiles(section: SectionLike): string[] {
  const files: string[] = [];
  for (const line of section.body.split(/\r?\n/)) {
    if (!CREATE_LINE.test(line)) continue;
    files.push(...extractFilePaths(line));
  }
  return unique(files);
}

function addDependency(edges: Map<string, Set<string>>, sectionId: string, dependencyId: string): void {
  if (sectionId === dependencyId) return;
  const deps = edges.get(sectionId) ?? new Set<string>();
  deps.add(dependencyId);
  edges.set(sectionId, deps);
}

function inferExplicitDependencies(sections: SectionLike[], edges: Map<string, Set<string>>): void {
  const aliases = new Map<string, string>();
  for (const section of sections) {
    for (const alias of sectionAliases(section)) {
      if (alias) aliases.set(alias, section.id);
    }
  }

  for (const section of sections) {
    for (const line of section.body.split(/\r?\n/)) {
      const match = line.match(DEPENDENCY_LINE);
      if (!match) continue;
      const targetText = normalizeToken(match[1]);
      for (const [alias, dependencyId] of aliases.entries()) {
        if (!alias || dependencyId === section.id) continue;
        if (targetText === alias || targetText.includes(alias)) {
          addDependency(edges, section.id, dependencyId);
        }
      }
    }
  }
}

function inferFileDependencies(
  sections: SectionLike[],
  edges: Map<string, Set<string>>,
  produced: Record<string, string[]>,
  referenced: Record<string, string[]>
): void {
  const producers = new Map<string, string>();
  for (const section of sections) {
    for (const file of produced[section.id] ?? []) {
      producers.set(file.toLowerCase(), section.id);
    }
  }

  for (const section of sections) {
    const ownProduced = new Set((produced[section.id] ?? []).map((file) => file.toLowerCase()));
    const references = extractFilePaths(section.body).filter((file) => !ownProduced.has(file.toLowerCase()));
    referenced[section.id] = references;
    for (const file of references) {
      const producer = producers.get(file.toLowerCase());
      if (producer) {
        addDependency(edges, section.id, producer);
      }
    }
  }
}

export function inferSectionDependencies(sections: SectionLike[]): SectionDependencyGraph {
  const edges = new Map<string, Set<string>>();
  const produced: Record<string, string[]> = {};
  const referenced: Record<string, string[]> = {};

  for (const section of sections) {
    produced[section.id] = producedFiles(section);
    referenced[section.id] = [];
  }

  inferExplicitDependencies(sections, edges);
  inferFileDependencies(sections, edges, produced, referenced);

  const dependencies: Record<string, string[]> = {};
  for (const section of sections) {
    dependencies[section.id] = Array.from(edges.get(section.id) ?? []).sort();
  }

  return {
    dependencies,
    produced_files: produced,
    referenced_files: referenced,
    notes: [
      "Dependencies are inferred deterministically from section ids/titles in dependency lines and from backticked file paths produced by upstream sections.",
      "Natural-language dependency inference is conservative; ambiguous prose should use 'Depends on:' with section titles or ids.",
    ],
  };
}
