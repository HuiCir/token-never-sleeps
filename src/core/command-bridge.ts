import { execa } from "execa";
import { resolve, relative } from "node:path";
import { appendJsonl, readJson, writeJson } from "../lib/fs.js";
import { commandBridgeSettings } from "../lib/config.js";
import { iso, utcNow } from "../lib/time.js";
import type { CommandInvocationSpec, CommandRunResult, Section, StatePaths, TnsConfig, ValidatorStage } from "../types.js";

function withinWorkspace(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !rel.includes("/../") && rel !== "..");
}

function matchesRule(rule: { match_title?: string; match_step?: string }, section: Section | null, step: string): boolean {
  const titleOk = !rule.match_title || (section ? section.title.includes(rule.match_title) : false);
  const stepOk = !rule.match_step || rule.match_step === step;
  return titleOk && stepOk;
}

async function appendCommandRun(paths: StatePaths, result: CommandRunResult): Promise<void> {
  await appendJsonl(paths.command_runs, result as unknown as Record<string, unknown>);
  const diagnostics = await readJson<Record<string, unknown>>(paths.diagnostics, {});
  const lastRuns = Array.isArray(diagnostics?.last_command_runs) ? diagnostics.last_command_runs.slice(-9) : [];
  lastRuns.push(result);
  await writeJson(paths.diagnostics, {
    ...(diagnostics ?? {}),
    updated_at: iso(utcNow()),
    last_command_runs: lastRuns,
  });
}

export async function runCommandSet(paths: StatePaths, config: TnsConfig, id: string, stage: ValidatorStage, section: Section | null, step: string): Promise<CommandRunResult> {
  const bridge = commandBridgeSettings(config);
  const spec = bridge.command_sets[id];
  if (!spec) {
    throw new Error(`command set not found: ${id}`);
  }
  const commands: CommandInvocationSpec[] = Array.isArray(spec.commands) && spec.commands.length > 0
    ? spec.commands
    : Array.isArray(spec.command) && spec.command.length > 0
      ? [{
          exec: spec.command[0],
          args: spec.command.slice(1),
          cwd: spec.cwd,
          timeout_seconds: spec.timeout_seconds,
          env: spec.env,
          allowed_exit_codes: spec.allowed_exit_codes,
          description: spec.description,
        }]
      : [];
  if (commands.length === 0) {
    throw new Error(`command set '${id}' has no command`);
  }

  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const finishedAt = iso(utcNow());
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let ok = true;
  let lastExitCode: number | null = 0;
  let lastCwd = resolve(paths.workspace, spec.cwd ?? ".");
  const commandWords: string[] = [];

  for (const invocation of commands) {
    const cwd = resolve(paths.workspace, invocation.cwd ?? spec.cwd ?? ".");
    if (!withinWorkspace(paths.workspace, cwd)) {
      throw new Error(`command set '${id}' cwd escapes workspace: ${invocation.cwd ?? spec.cwd}`);
    }
    lastCwd = cwd;
    const cmd = [invocation.exec, ...(invocation.args ?? [])];
    commandWords.push(...cmd);
    const proc = await execa(invocation.exec, invocation.args ?? [], {
      cwd,
      reject: false,
      encoding: "utf8",
      captureOutput: true,
      timeout: Math.max(1, Number(invocation.timeout_seconds ?? spec.timeout_seconds ?? 300)) * 1000,
      env: { ...(spec.env ?? {}), ...(invocation.env ?? {}) },
    });
    lastExitCode = proc.exitCode ?? null;
    if (proc.stdout) stdoutChunks.push(proc.stdout);
    if (proc.stderr) stderrChunks.push(proc.stderr);
    const allowedExitCodes = invocation.allowed_exit_codes ?? spec.allowed_exit_codes ?? [0];
    if (!allowedExitCodes.includes(proc.exitCode ?? 1)) {
      ok = false;
      break;
    }
  }

  const result: CommandRunResult = {
    id,
    ok,
    stage,
    section_id: section?.id,
    step,
    command: commandWords,
    cwd: lastCwd,
    exit_code: lastExitCode,
    stdout: stdoutChunks.join("\n"),
    stderr: stderrChunks.join("\n"),
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Date.now() - started,
  };
  await appendCommandRun(paths, result);
  await appendJsonl(paths.activity, {
    event: result.ok ? "command_set_ok" : "command_set_fail",
    at: finishedAt,
    section: section?.id,
    step,
    command_set: id,
    stage,
    exit_code: result.exit_code,
  });
  return result;
}

export async function runStageCommandHooks(paths: StatePaths, config: TnsConfig, stage: ValidatorStage, section: Section | null, step: string): Promise<CommandRunResult[]> {
  const bridge = commandBridgeSettings(config);
  const matched = (bridge.hooks ?? []).filter((rule) => rule.stage === stage && matchesRule(rule, section, step));
  const results: CommandRunResult[] = [];
  for (const rule of matched) {
    await appendJsonl(paths.hook_events, {
      event: "hook_match",
      at: iso(utcNow()),
      stage,
      section: section?.id ?? null,
      step,
      command_sets: rule.command_sets,
      match_title: rule.match_title ?? null,
      match_step: rule.match_step ?? null,
    });
    for (const id of rule.command_sets) {
      await appendJsonl(paths.hook_events, {
        event: "hook_start",
        at: iso(utcNow()),
        stage,
        section: section?.id ?? null,
        step,
        command_set: id,
      });
      results.push(await runCommandSet(paths, config, id, stage, section, step));
      await appendJsonl(paths.hook_events, {
        event: "hook_end",
        at: iso(utcNow()),
        stage,
        section: section?.id ?? null,
        step,
        command_set: id,
      });
    }
  }
  return results;
}
