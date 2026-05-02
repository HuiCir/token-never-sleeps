import type { Section, StatePaths } from "../types.js";
import { readJson, writeJson, appendJsonl } from "../lib/fs.js";
import { iso, utcNow } from "../lib/time.js";
import { ensureSectionDefaults, parseSections } from "./sections.js";

function sectionStateSignature(section: Section): string {
  return JSON.stringify({
    id: section.id,
    title: section.title,
    anchor: section.anchor,
    body: section.body,
  });
}

export async function syncSectionStateFromTask(
  productDoc: string,
  paths: StatePaths,
  reason: string
): Promise<{ changed: boolean; previous_count: number; current_count: number }> {
  const parsed = parseSections(productDoc).map(ensureSectionDefaults);
  const existing = ((await readJson<Section[]>(paths.sections)) || []).map(ensureSectionDefaults);
  if (
    parsed.length === existing.length &&
    parsed.every((section, index) => sectionStateSignature(section) === sectionStateSignature(existing[index]))
  ) {
    return { changed: false, previous_count: existing.length, current_count: parsed.length };
  }

  const existingByStableKey = new Map<string, Section>();
  for (const section of existing) {
    if (section.status === "in_progress") continue;
    existingByStableKey.set(`${section.id}\n${section.title}`, section);
    existingByStableKey.set(`title\n${section.title}`, section);
  }

  const merged = parsed.map((section) => {
    const prior = existingByStableKey.get(`${section.id}\n${section.title}`) ?? existingByStableKey.get(`title\n${section.title}`);
    if (!prior) return section;
    return {
      ...section,
      status: prior.status,
      attempts: prior.attempts,
      verified_at: prior.verified_at,
      last_summary: prior.last_summary,
      last_review: prior.last_review,
      current_step: prior.current_step,
    };
  });

  await writeJson(paths.sections, merged);
  const diagnostics = await readJson<Record<string, unknown>>(paths.diagnostics, {});
  await writeJson(paths.diagnostics, {
    ...(diagnostics ?? {}),
    updated_at: iso(utcNow()),
    last_recovery_decision: {
      action: "sync_sections",
      reason,
      at: iso(utcNow()),
      previous_count: existing.length,
      current_count: merged.length,
    },
  });
  await appendJsonl(paths.activity, {
    event: "auto_sync_sections",
    at: iso(utcNow()),
    reason,
    previous_count: existing.length,
    current_count: merged.length,
  });

  return { changed: true, previous_count: existing.length, current_count: merged.length };
}
