import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { readJson, writeJson } from "../lib/fs.js";
import { iso, utcNow } from "../lib/time.js";
import type { ActivityEvent, ArtifactRecord, Section, StatePaths } from "../types.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function touchedFiles(result: Record<string, unknown>): string[] {
  const files = result.files_touched;
  return Array.isArray(files) ? files.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

async function readActivity(path: string): Promise<ActivityEvent[]> {
  try {
    const content = await readFile(path, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ActivityEvent);
  } catch {
    return [];
  }
}

function resolveArtifactPath(workspace: string, filePath: string): string {
  return isAbsolute(filePath) ? resolve(filePath) : resolve(workspace, filePath);
}

export async function rebuildArtifactIndex(paths: StatePaths): Promise<ArtifactRecord[]> {
  const sections = (await readJson<Section[]>(paths.sections, [])) || [];
  const sectionById = new Map(sections.map((section) => [section.id, section]));
  const events = await readActivity(paths.activity);
  const verifiedBySection = new Map<string, boolean>();

  for (const event of events) {
    const sectionId = event.section;
    if (!sectionId) continue;

    const result = asRecord(event.result);
    const status = result.status;
    if (event.event === "verifier_end" || (event.event === "agent_end" && typeof status === "string")) {
      verifiedBySection.set(sectionId, status === "pass");
    }
  }

  const bySection = new Map<string, Map<string, ArtifactRecord>>();
  for (const event of events) {
    const sectionId = event.section;
    if (!sectionId) continue;

    const result = asRecord(event.result);
    const files = touchedFiles(result);
    if (event.event !== "executor_end" && !(event.event === "agent_end" && files.length > 0)) {
      continue;
    }

    const section = sectionById.get(sectionId);
    const bucket = bySection.get(sectionId) || new Map<string, ArtifactRecord>();
    for (const filePath of files) {
      const resolved = resolveArtifactPath(paths.workspace, filePath);
      bucket.set(resolved, {
        section_id: sectionId,
        section_title: section?.title || "",
        path: resolved,
        exists: await fileExists(resolved),
        indexed_at: event.at || iso(utcNow()),
        verified: verifiedBySection.get(sectionId) ?? section?.status === "done",
      });
    }
    bySection.set(sectionId, bucket);
  }

  const artifacts: ArtifactRecord[] = [];
  for (const sectionId of Array.from(bySection.keys()).sort()) {
    artifacts.push(...Array.from(bySection.get(sectionId)?.values() || []));
  }
  await writeJson(paths.artifacts, artifacts);
  return artifacts;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
