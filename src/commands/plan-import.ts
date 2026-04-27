import { readFileSync } from "node:fs";
import { loadConfig } from "../lib/config.js";
import { statePaths, ensureInitialized } from "../core/state.js";
import { readJson, writeJson } from "../lib/fs.js";
import { parsePlanSections } from "../core/plan-parser.js";
import { ensureSectionDefaults } from "../core/sections.js";
import type { Section } from "../types.js";
import { withResourceLocks } from "../lib/lock.js";

export async function cmdPlanImport(args: { config: string; plan_file?: string; planFile?: string; merge: boolean }): Promise<void> {
  const config = loadConfig(args.config);
  const planPath = args.plan_file || args.planFile;
  if (!planPath) {
    console.error("ERROR: plan-file is required");
    process.exit(1);
  }
  let planText: string;
  try {
    planText = readFileSync(planPath, "utf-8");
  } catch {
    console.error(`ERROR: plan file not found: ${planPath}`);
    process.exit(1);
  }

  const newSections = parsePlanSections(planText);
  await withResourceLocks(config.workspace, ["workspace", "config", "state"], "tns plan-import", async () => {
    const paths = await ensureInitialized(config);

    if (args.merge) {
      const existing = (await readJson<Section[]>(paths.sections)) || [];
      const existingByTitle = new Map(existing.map((s) => [s.title, s]));

      for (const ns of newSections) {
        if (existingByTitle.has(ns.title)) {
          const existingSection = existingByTitle.get(ns.title)!;
          ns.status = existingSection.status;
          ns.attempts = existingSection.attempts;
          ns.verified_at = existingSection.verified_at;
          ns.last_summary = existingSection.last_summary;
          ns.last_review = existingSection.last_review;
          ns.current_step = existingSection.current_step;
        } else {
          ns.status = "pending";
          ns.attempts = 0;
        }
      }

      const kept = existing.filter((s) => s.status === "done" || s.status === "blocked");
      const pending = newSections.filter((s) => s.status === "pending");
      const sections = [...kept, ...pending].map(ensureSectionDefaults);
      await writeJson(paths.sections, sections);
    } else {
      const sections = newSections.map(ensureSectionDefaults);
      await writeJson(paths.sections, sections);
    }

    const allSections = (await readJson<Section[]>(paths.sections)) || [];
    const doneCount = allSections.filter((s) => s.status === "done").length;

    console.log(`Imported ${newSections.length} sections from ${planPath.split("/").pop()}`);
    console.log(`Total sections: ${allSections.length} (done=${doneCount})`);
  });
}
