import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { commandBridgeSettings, preflightSettings, validatorSettings } from "../lib/config.js";
import { appendJsonl, readJson, writeJson } from "../lib/fs.js";
import { iso, utcNow } from "../lib/time.js";
import type { Section, StatePaths, TnsConfig, ValidatorResult, ValidatorSpec, ValidatorStage } from "../types.js";
import { runCommandSet } from "./command-bridge.js";

function matchesRule(spec: ValidatorSpec, section: Section | null, step: string): boolean {
  const titleOk = !spec.match_title || (section ? section.title.includes(spec.match_title) : false);
  const stepOk = !spec.match_step || spec.match_step === step;
  return titleOk && stepOk;
}

function nestedValue(input: unknown, path: string): unknown {
  const parts = path.split(".");
  let current = input;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

async function validateOne(paths: StatePaths, config: TnsConfig, spec: ValidatorSpec, section: Section | null, step: string): Promise<ValidatorResult> {
  const path = spec.path ? resolve(paths.workspace, spec.path) : "";
  const sectionId = section?.id;

  try {
    if (spec.kind === "file_exists") {
      const info = await stat(path);
      return { id: spec.id, stage: spec.stage, ok: info.isFile(), message: info.isFile() ? `file exists: ${spec.path}` : `path is not a file: ${spec.path}`, section_id: sectionId, step };
    }
    if (spec.kind === "directory_exists") {
      const info = await stat(path);
      return { id: spec.id, stage: spec.stage, ok: info.isDirectory(), message: info.isDirectory() ? `directory exists: ${spec.path}` : `path is not a directory: ${spec.path}`, section_id: sectionId, step };
    }
    if (spec.kind === "text_regex" || spec.kind === "text_not_regex") {
      const content = await readFile(path, "utf-8");
      const regex = new RegExp(spec.pattern || "", spec.flags || "");
      const matched = regex.test(content);
      const ok = spec.kind === "text_regex" ? matched : !matched;
      return {
        id: spec.id,
        stage: spec.stage,
        ok,
        message: ok ? `text validator passed: ${spec.id}` : `text validator failed: ${spec.id}`,
        section_id: sectionId,
        step,
        details: { path: spec.path, pattern: spec.pattern },
      };
    }
    if (spec.kind === "json_path_equals") {
      const content = await readFile(path, "utf-8");
      const parsed = JSON.parse(content) as unknown;
      const actual = nestedValue(parsed, spec.json_path || "");
      const ok = actual === spec.equals;
      return {
        id: spec.id,
        stage: spec.stage,
        ok,
        message: ok ? `json path matched: ${spec.json_path}` : `json path mismatch at ${spec.json_path}`,
        section_id: sectionId,
        step,
        details: { path: spec.path, actual, expected: spec.equals },
      };
    }
    if (spec.kind === "command_set") {
      const bridge = commandBridgeSettings(config);
      const id = spec.command_set || spec.id;
      if (!bridge.command_sets[id]) {
        return { id: spec.id, stage: spec.stage, ok: false, message: `command set not defined: ${id}`, section_id: sectionId, step };
      }
      const cmd = await runCommandSet(paths, config, id, spec.stage, section, step);
      return {
        id: spec.id,
        stage: spec.stage,
        ok: cmd.ok,
        message: cmd.ok ? `command set passed: ${id}` : `command set failed: ${id}`,
        section_id: sectionId,
        step,
        details: { command_set: id, exit_code: cmd.exit_code },
      };
    }
    return { id: spec.id, stage: spec.stage, ok: false, message: `unsupported validator kind: ${spec.kind}`, section_id: sectionId, step };
  } catch (error: unknown) {
    return {
      id: spec.id,
      stage: spec.stage,
      ok: false,
      message: `${spec.kind} validator error: ${String(error)}`,
      section_id: sectionId,
      step,
      details: { path: spec.path },
    };
  }
}

async function writeDiagnostics(paths: StatePaths, stage: ValidatorStage, results: ValidatorResult[]): Promise<void> {
  const diagnostics = await readJson<Record<string, unknown>>(paths.diagnostics, {});
  const key = stage === "preflight" ? "last_preflight" : "last_validator_results";
  await writeJson(paths.diagnostics, {
    ...(diagnostics ?? {}),
    updated_at: iso(utcNow()),
    [key]: results,
  });
}

export async function runWorkspacePreflight(paths: StatePaths, config: TnsConfig): Promise<ValidatorResult[]> {
  const settings = preflightSettings(config);
  const results: ValidatorResult[] = [];

  for (const file of settings.required_files ?? []) {
    results.push(await validateOne(paths, config, {
      id: `required-file:${file}`,
      stage: "preflight",
      kind: "file_exists",
      path: file,
    }, null, "preflight"));
  }
  for (const dir of settings.required_directories ?? []) {
    results.push(await validateOne(paths, config, {
      id: `required-dir:${dir}`,
      stage: "preflight",
      kind: "directory_exists",
      path: dir,
    }, null, "preflight"));
  }

  const validators = validatorSettings(config).filter((spec) => spec.stage === "preflight");
  for (const spec of validators) {
    results.push(await validateOne(paths, config, spec, null, "preflight"));
  }

  await writeDiagnostics(paths, "preflight", results);
  await appendJsonl(paths.activity, {
    event: "preflight_complete",
    at: iso(utcNow()),
    ok: results.every((item) => item.ok),
    failures: results.filter((item) => !item.ok).map((item) => item.id),
  });
  return results;
}

export async function runStageValidators(paths: StatePaths, config: TnsConfig, stage: ValidatorStage, section: Section, step: string): Promise<ValidatorResult[]> {
  const validators = validatorSettings(config).filter((spec) => spec.stage === stage && matchesRule(spec, section, step));
  const results: ValidatorResult[] = [];
  for (const spec of validators) {
    results.push(await validateOne(paths, config, spec, section, step));
  }
  if (results.length > 0) {
    await writeDiagnostics(paths, stage, results);
  }
  await appendJsonl(paths.activity, {
    event: "validators_complete",
    at: iso(utcNow()),
    section: section.id,
    step,
    stage,
    ok: results.every((item) => item.ok),
    failures: results.filter((item) => !item.ok).map((item) => item.id),
  });
  return results;
}
