import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Section } from "../types.js";

export function ensureSectionDefaults(section: Partial<Section> & { id: string }): Section {
  const s = section as Section;
  s.status = s.status ?? "pending";
  s.attempts = s.attempts ?? 0;
  s.verified_at = s.verified_at ?? null;
  s.last_summary = s.last_summary ?? "";
  s.last_review = s.last_review ?? "";
  s.current_step = s.current_step ?? "";
  s.body = s.body ?? "";
  return s;
}

export function parseSections(productDocPath: string): Section[] {
  const text = readFileSync(resolve(productDocPath), "utf-8");
  const lines = text.split("\n");
  const sections: Section[] = [];
  let current: Partial<Section> & { _bodyLines?: string[] } | null = null;

  for (const line of lines) {
    const match = line.match(/^(##|###)\s+(.+?)\s*$/);
    if (match) {
      if (current && current.id) {
        current.body = (current._bodyLines || []).join("\n").trim();
        const c = current as Record<string, unknown>;
        delete c['_bodyLines'];
        sections.push(current as Section);
      }
      const num = sections.length + 1;
      current = {
        id: `sec-${String(num).padStart(3, "0")}`,
        title: match[2].trim(),
        anchor: line.trim(),
        body: "",
        _bodyLines: [],
        status: "pending",
        attempts: 0,
        verified_at: null,
        last_summary: "",
        last_review: "",
        current_step: "",
      };
      continue;
    }
    if (current) {
      current._bodyLines = current._bodyLines || [];
      current._bodyLines.push(line);
    }
  }

  if (current && current.id) {
    current.body = (current._bodyLines || []).join("\n").trim();
    const c = current as Record<string, unknown>;
    delete c['_bodyLines'];
    sections.push(current as Section);
  }

  if (sections.length === 0) {
    sections.push({
      id: "sec-001",
      title: productDocPath.split("/").pop() || "Task",
      anchor: "# Task",
      body: lines.join("\n").trim(),
      status: "pending",
      attempts: 0,
      verified_at: null,
      last_summary: "",
      last_review: "",
      current_step: "",
    });
  }

  return sections.map(ensureSectionDefaults);
}

export function selectSection(sections: Section[], maxAttempts: number = 3): Section | null {
  for (const section of sections) {
    ensureSectionDefaults(section);
    if (section.attempts >= maxAttempts && section.status === "pending") {
      section.status = "blocked";
    }
  }

  for (const status of ["needs_fix", "pending", "blocked"]) {
    for (const section of sections) {
      if (section.status === status) return section;
    }
  }
  return null;
}

export function updateSection(sections: Section[], sectionId: string, updates: Partial<Section>): void {
  for (const section of sections) {
    ensureSectionDefaults(section);
    if (section.id === sectionId) {
      Object.assign(section, updates);
      return;
    }
  }
  throw new Error(`section not found: ${sectionId}`);
}

export function recoverInProgressSections(sections: Section[]): boolean {
  let changed = false;
  for (const section of sections) {
    ensureSectionDefaults(section);
    if (section.status === "in_progress") {
      section.status = "needs_fix";
      section.current_step = "";
      const prefix = "Recovered after interrupted run.";
      section.last_review = `${prefix} ${section.last_review}`.trim();
      changed = true;
    }
  }
  return changed;
}
