import type { Section } from "../types.js";
import { ensureSectionDefaults } from "./sections.js";

export function parsePlanSections(planText: string): Section[] {
  const lines = planText.split("\n");
  const sections: Section[] = [];
  let current: Partial<Section> & { _bodyLines?: string[] } | null = null;

  for (const line of lines) {
    const match = line.match(/^(##|###)\s+(.+?)\s*$/);
    if (match) {
      if (current && current.id) {
        current.body = (current._bodyLines || []).join("\n").trim();
        delete (current as Record<string, unknown>)['_bodyLines'];
        sections.push(current as Section);
      }
      const headingText = match[2].trim();
      const title = headingText;

      current = {
        id: `sec-${String(sections.length + 1).padStart(3, "0")}`,
        title,
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
    delete (current as Record<string, unknown>)['_bodyLines'];
    sections.push(current as Section);
  }

  if (sections.length === 0) {
    sections.push({
      id: "sec-001",
      title: "Plan",
      anchor: "# Plan",
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
