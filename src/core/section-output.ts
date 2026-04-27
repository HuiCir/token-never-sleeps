import { writeJson } from "../lib/fs.js";
import { iso, utcNow } from "../lib/time.js";
import type { CommandRunResult, Section, SectionOutputRecord, StatePaths, ValidatorResult } from "../types.js";

export async function writeSectionOutput(
  paths: StatePaths,
  section: Section,
  stepResults: Array<{ node_id: string; payload: Record<string, unknown>; usage: Record<string, unknown> }>,
  validatorResults: ValidatorResult[],
  commandRuns: CommandRunResult[]
): Promise<void> {
  const record: SectionOutputRecord = {
    section_id: section.id,
    section_title: section.title,
    status: section.status,
    current_step: section.current_step,
    updated_at: iso(utcNow()),
    step_results: stepResults,
    validator_results: validatorResults,
    command_runs: commandRuns,
  };
  await writeJson(`${paths.section_outputs_dir}/${section.id}.json`, record);
}
