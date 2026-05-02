import { loadConfig, workflowSettings, attemptsSettings, explorationSettings, outputSettings, policySettings, executionSettings } from "../lib/config.js";
import { statePaths, ensureInitialized, loadManifest } from "../core/state.js";
import { readJson, writeJson, appendJsonl, pathExists, removePath, resolvePath as resolveFsPath } from "../lib/fs.js";
import { iso, utcNow, sleep } from "../lib/time.js";
import { looksLikeUsageLimitError, looksLikeRetryableError } from "../lib/errors.js";
import { selectSection, updateSection, recoverInProgressSections, ensureSectionDefaults, parseSections } from "../core/sections.js";
import { runAgent, schemaByName } from "../core/agent.js";
import { firstMatchingTransition, applyTransitionToSection } from "../core/workflow.js";
import { appendHandoff } from "../core/handoff.js";
import { rebuildArtifactIndex } from "../core/artifacts.js";
import type { FsmParallelPlan, FsmParallelPlanItem, FsmProgramSettings, Section, ExecutorResult, VerifierResult, ReviewRecord, TnsConfig, ExplorationResult, ExplorationState } from "../types.js";
import { withResourceLocks } from "../lib/lock.js";
import { beginRuntime, endRuntime, heartbeatRuntime, recoverRuntimeIfInterrupted } from "../core/runtime.js";
import { currentWindow } from "../lib/time.js";
import { loadApprovals, recordApprovalRequest } from "../core/approvals.js";
import { missingApprovalTag, permissionSettings, resolvePermissionProfile, type ResolvedPermissionProfile } from "../lib/permissions.js";
import { basename, relative, resolve as resolvePath } from "node:path";
import { readFile } from "node:fs/promises";
import { applyPolicyAction, policyActionFor } from "../lib/policy.js";
import { runStageCommandHooks } from "../core/command-bridge.js";
import { runStageValidators, runWorkspacePreflight } from "../core/validators.js";
import { writeSectionOutput } from "../core/section-output.js";
import type { CommandRunResult, ValidatorResult } from "../types.js";
import { gcPluginSandbox, preparePluginSandbox, resolveInjectionProfile, resolveManagedInjectionProfile, type ResolvedInjectionProfile } from "../lib/injections.js";
import { classifySectionRecovery } from "../core/self-healing.js";
import { buildCompiledProgram } from "./compile.js";
import { syncSectionStateFromTask } from "../core/section-state.js";

interface RunLoopResult {
  ran: boolean;
  nextWakeAt?: string | null;
}

const EMPTY_EXPLORATION_STATE: ExplorationState = {
  window_index: null,
  rounds_run: 0,
  last_outcome: "idle",
  last_summary: "",
  last_taskx_path: null,
  updated_at: null,
};

let stateMutationQueue: Promise<unknown> = Promise.resolve();

async function withStateMutation<T>(fn: () => Promise<T>): Promise<T> {
  const run = stateMutationQueue.then(fn, fn);
  stateMutationQueue = run.catch(() => undefined);
  return run;
}

async function heartbeatRuntimeSerial(paths: ReturnType<typeof statePaths>, patch?: Parameters<typeof heartbeatRuntime>[1]): Promise<void> {
  await withStateMutation(async () => {
    await heartbeatRuntime(paths, patch);
  });
}

function injectedSkillNames(profile: ResolvedInjectionProfile): string[] {
  return [
    ...profile.skills,
    ...profile.external_skill_paths.map((item) => item.split("/").pop() || item),
  ];
}

function injectionPromptBlock(profile: ResolvedInjectionProfile): string {
  return `Injected skill profile:
- profile: ${profile.profile_name ?? "(none)"}
- mode: ${profile.mode}
- explicit skills: ${(profile.explicit_skills ?? profile.skills).join(", ") || "(none)"}
- auto-selected skills: ${(profile.auto_skills ?? []).join(", ") || "(none)"}
- external skills: ${profile.external_skill_paths.join(", ") || "(none)"}
- add_dirs: ${profile.add_dirs.join(", ") || "(none)"}

Skill-use contract:
- If a listed skill is relevant, read and apply its SKILL.md before acting.
- Executor skills and verifier skills are stage-local; verifier does not inherit executor problem-solving skills unless config explicitly injects them.
- Verifier-stage skills are for independent audit, readonly inspection, schema checks, test execution, and evidence review, not for repairing or re-solving the task.
- Include used skill names in skills_used when the output schema supports it.
- If no injected skill is relevant, leave skills_used empty and explain the verification or execution basis in checks_run.`;
}

function configForAgentMode(config: TnsConfig, mode: ResolvedInjectionProfile["mode"]): TnsConfig {
  const execution = executionSettings(config);
  const classSettings = mode === "verifier"
    ? execution.verifier
    : mode === "executor"
      ? execution.long_running
      : null;
  if (!classSettings?.max_runtime_seconds) {
    return config;
  }
  return {
    ...config,
    monitor: {
      ...(config.monitor ?? {}),
      max_agent_runtime_seconds: classSettings.max_runtime_seconds,
    },
  };
}

function clearAgentRuntimeFields() {
  return {
    current_agent: null,
    agent_pid: null,
    agent_started_at: null,
    agent_deadline_at: null,
  };
}

function summarizeFailures<T extends { id: string; message: string }>(items: T[]): string {
  return items.map((item) => `${item.id}: ${item.message}`).join("; ");
}

async function persistSectionOutputIfEnabled(
  config: TnsConfig,
  paths: ReturnType<typeof statePaths>,
  section: Section,
  stepResults: { node_id: string; payload: Record<string, unknown>; usage: unknown }[],
  validatorResults: ValidatorResult[],
  commandRuns: CommandRunResult[]
): Promise<void> {
  if (!outputSettings(config).write_section_outputs) {
    return;
  }
  await writeSectionOutput(
    paths,
    section,
    stepResults.map((item) => ({ node_id: item.node_id, payload: item.payload, usage: item.usage as Record<string, unknown> })),
    validatorResults,
    commandRuns
  );
}

function ensureFilesTouchedStayInWorkspace(workspace: string, filesTouched: string[]): void {
  const root = resolvePath(workspace);
  for (const file of filesTouched) {
    const resolved = resolvePath(root, file);
    const rel = relative(root, resolved);
    if (rel === "" || (!rel.startsWith("..") && !rel.includes("/../") && rel !== "..")) {
      continue;
    }
    throw new Error(`files_touched contains path outside workspace: ${file}`);
  }
}

async function configWithCompiledProgram(config: TnsConfig, paths: ReturnType<typeof statePaths>): Promise<TnsConfig> {
  if (config.program) {
    return config;
  }
  const compiled = await readJson<Record<string, unknown>>(paths.compiled_program);
  const inputs = compiled?.inputs;
  const orchestration = compiled?.orchestration;
  const candidate = inputs && typeof inputs === "object" && !Array.isArray(inputs)
    ? (inputs as Record<string, unknown>).program
    : orchestration && typeof orchestration === "object" && !Array.isArray(orchestration)
      ? (orchestration as Record<string, unknown>).program
      : null;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return config;
  }
  const program = candidate as Partial<FsmProgramSettings>;
  if (!program.entry || !Array.isArray(program.states)) {
    return config;
  }
  return { ...config, program: program as FsmProgramSettings, _program_from_compiled: true };
}

function compileSourceConfig(config: TnsConfig): TnsConfig {
  if (!config._program_from_compiled) {
    return config;
  }
  const source = { ...config };
  delete source.program;
  delete source._program_from_compiled;
  return source;
}

function canAutoRecompileProgram(config: TnsConfig): boolean {
  return !config.program || Boolean(config._program_from_compiled);
}

async function refreshCompiledProgram(
  config: TnsConfig,
  paths: ReturnType<typeof statePaths>,
  reason: string,
  meta?: Record<string, unknown>,
  options?: { allowExplicitProgram?: boolean }
): Promise<boolean> {
  if (!canAutoRecompileProgram(config) && !options?.allowExplicitProgram) {
    return false;
  }
  const compiled = await buildCompiledProgram(options?.allowExplicitProgram ? config : compileSourceConfig(config), paths);
  await writeJson(paths.compiled_program, compiled);
  const diagnostics = await readJson<Record<string, unknown>>(paths.diagnostics, {});
  await writeJson(paths.diagnostics, {
    ...(diagnostics ?? {}),
    updated_at: iso(utcNow()),
    last_recovery_decision: {
      action: "recompile",
      reason,
      at: iso(utcNow()),
      ...meta,
    },
  });
  await appendJsonl(paths.activity, {
    event: "auto_recompile",
    at: iso(utcNow()),
    reason,
    compiled_program: paths.compiled_program,
    ...meta,
  });
  return true;
}

async function currentTaskDigest(config: TnsConfig): Promise<{ filename: string; section_count: number; bytes: number }> {
  const taskText = await readFile(config.product_doc, "utf-8");
  return {
    filename: basename(config.product_doc),
    section_count: parseSections(config.product_doc).length,
    bytes: Buffer.byteLength(taskText, "utf8"),
  };
}

async function ensureCompiledProgramFresh(config: TnsConfig, paths: ReturnType<typeof statePaths>): Promise<void> {
  const compiled = await readJson<Record<string, unknown>>(paths.compiled_program);
  if (!compiled) {
    const requestedThreads = Math.max(1, Number(config.threads ?? config.thread ?? 1));
    if (requestedThreads > 1) {
      await refreshCompiledProgram(
        config,
        paths,
        "compiled program missing for multi-thread run",
        { trigger: "missing_compiled_program" },
        { allowExplicitProgram: true }
      );
    }
    return;
  }

  const digest = await currentTaskDigest(config);
  const workspace = compiled.workspace && typeof compiled.workspace === "object" ? compiled.workspace as Record<string, unknown> : {};
  const compiledDigest = workspace.task_digest && typeof workspace.task_digest === "object"
    ? workspace.task_digest as Record<string, unknown>
    : {};
  if (compiledDigest.bytes !== digest.bytes || compiledDigest.section_count !== digest.section_count || compiledDigest.filename !== digest.filename) {
    await refreshCompiledProgram(
      config,
      paths,
      "task document changed after compile",
      {
        trigger: "task_digest_mismatch",
        previous: compiledDigest,
        current: digest,
      },
      { allowExplicitProgram: true }
    );
  }
}

async function ensureSectionStateFresh(config: TnsConfig, paths: ReturnType<typeof statePaths>): Promise<void> {
  await syncSectionStateFromTask(config.product_doc, paths, "task document sections changed after state initialization");
}

async function applyRuntimeRecoveryDecisions(
  config: TnsConfig,
  paths: ReturnType<typeof statePaths>,
  sections: Section[],
  maxAttempts: number
): Promise<{ sections: Section[]; changed: boolean; recompiled: boolean }> {
  let changed = false;
  let recompiled = false;
  for (const section of sections) {
    ensureSectionDefaults(section);
    if (!["pending", "needs_fix", "blocked"].includes(section.status)) continue;
    if (section.status === "blocked" && /^(Runtime diagnosis|Execution exhausted)/.test(section.last_review)) continue;
    if (section.attempts < maxAttempts && section.status !== "blocked") continue;

    const decision = classifySectionRecovery(section, maxAttempts);
    const diagnostics = await readJson<Record<string, unknown>>(paths.diagnostics, {});
    await writeJson(paths.diagnostics, {
      ...(diagnostics ?? {}),
      updated_at: iso(utcNow()),
      last_recovery_decision: {
        section: section.id,
        status: section.status,
        attempts: section.attempts,
        category: decision.category,
        reason: decision.reason,
        signals: decision.signals,
        at: iso(utcNow()),
      },
    });
    await appendJsonl(paths.activity, {
      event: "runtime_recovery_decision",
      at: iso(utcNow()),
      section: section.id,
      category: decision.category,
      reason: decision.reason,
      signals: decision.signals,
      attempts: section.attempts,
    });

    if (decision.category === "execution_retry") {
      continue;
    }

    if (decision.category === "orchestration_recompile") {
      const compiled = await refreshCompiledProgram(config, paths, decision.reason, {
        trigger: "runtime_recovery_decision",
        section: section.id,
        signals: decision.signals,
      });
      if (compiled) {
        section.status = "pending";
        section.attempts = 0;
        section.current_step = "";
        section.last_review = `Auto recompiled orchestration after runtime diagnosis: ${decision.reason}`;
        changed = true;
        recompiled = true;
        continue;
      }
      section.status = "blocked";
      section.current_step = "";
      section.last_review = `Runtime diagnosis requires program redesign, but config.program is explicit and was not auto-edited: ${decision.reason}`;
      changed = true;
      continue;
    }

    section.status = "blocked";
    section.current_step = "";
    section.last_review = `Execution exhausted without orchestration signals; manual review required before retry. ${decision.reason}`;
    changed = true;
  }

  return { sections, changed, recompiled };
}

export async function cmdRun(args: { config: string; once?: boolean; poll_seconds?: number }): Promise<void> {
  const initialConfig = loadConfig(args.config);
  await withResourceLocks(initialConfig.workspace, ["workspace", "runner", "state"], "tns run", async () => {
    const paths = await ensureInitialized(initialConfig, { autoInit: true });
    await ensureCompiledProgramFresh(initialConfig, paths);
    await ensureSectionStateFresh(initialConfig, paths);
    const config = await configWithCompiledProgram(initialConfig, paths);
    const manifest = await loadManifest(paths);
    await recoverRuntimeIfInterrupted(paths);
    await beginRuntime(paths, "tns run", "direct", { window_index: currentWindow(manifest).index });

    const successInterval = config.success_interval_seconds || 1;
    const idleInterval = config.idle_interval_seconds || 60;

    try {
      while (true) {
        let result: RunLoopResult = { ran: false };
        try {
          result = await runOnce(config, paths);
        } catch (exc: unknown) {
          console.error(`Error in run loop: ${exc}`);
          await markRunError(paths, exc);
          if (args.once) {
            process.exitCode = 1;
            break;
          }
        }
        if (args.once) break;
        const nextSleepSeconds = result.nextWakeAt
          ? Math.max(1, Math.ceil((Date.parse(result.nextWakeAt) - Date.now()) / 1000))
          : (result.ran ? successInterval : idleInterval);
        await heartbeatRuntime(paths, { sleep_until: new Date(Date.now() + nextSleepSeconds * 1000).toISOString() });
        await sleep(nextSleepSeconds);
        await heartbeatRuntime(paths, { sleep_until: null, window_index: currentWindow(manifest).index });
      }
    } finally {
      await endRuntime(paths, process.exitCode && process.exitCode !== 0 ? "error" : "stopped");
    }
  }, { waitMs: 2000 });
}

async function loadExplorationState(paths: ReturnType<typeof statePaths>): Promise<ExplorationState> {
  const state = await readJson<ExplorationState>(paths.exploration);
  if (!state || typeof state !== "object") {
    return { ...EMPTY_EXPLORATION_STATE };
  }
  return {
    window_index: typeof state.window_index === "number" ? state.window_index : null,
    rounds_run: typeof state.rounds_run === "number" ? state.rounds_run : 0,
    last_outcome: state.last_outcome ?? "idle",
    last_summary: state.last_summary ?? "",
    last_taskx_path: state.last_taskx_path ?? null,
    updated_at: state.updated_at ?? null,
  };
}

async function saveExplorationState(paths: ReturnType<typeof statePaths>, state: ExplorationState): Promise<void> {
  await writeJson(paths.exploration, state);
}

function nextSectionId(existing: Section[]): string {
  let max = 0;
  for (const section of existing) {
    const match = section.id.match(/^sec-(\d+)$/);
    if (!match) {
      continue;
    }
    max = Math.max(max, Number(match[1]));
  }
  return `sec-${String(max + 1).padStart(3, "0")}`;
}

function resolveDefaultPermissionProfile(config: TnsConfig): ResolvedPermissionProfile {
  const settings = permissionSettings(config);
  const profileName = settings.default_profile;
  const profile = settings.profiles[profileName] || {};
  const allowed = [
    ...(profile.allowed_tools ?? []),
    ...((profile.allowed_bash_commands ?? []).map((cmd) => cmd.startsWith("Bash(") ? cmd : `Bash(${cmd}:*)`)),
  ];
  const disallowed = [
    ...(profile.disallowed_tools ?? []),
    ...((profile.disallowed_bash_commands ?? []).map((cmd) => cmd.startsWith("Bash(") ? cmd : `Bash(${cmd}:*)`)),
  ];
  return {
    profile_name: profileName,
    permission_mode: profile.permission_mode ?? config.permission_mode ?? "acceptEdits",
    allowed_tools: Array.from(new Set(allowed)),
    disallowed_tools: Array.from(new Set(disallowed)),
    approval_tag: profile.requires_approval ?? null,
    workspace_only: profile.workspace_only ?? true,
    restricted_paths: Array.isArray(profile.restricted_paths) ? profile.restricted_paths.map(String) : [],
  };
}

async function importTaskxSections(paths: ReturnType<typeof statePaths>, taskxPath: string): Promise<number> {
  const taskxText = await readFile(taskxPath, "utf-8");
  const { parsePlanSections } = await import("../core/plan-parser.js");
  const parsed = parsePlanSections(taskxText);
  const existing = (await readJson<Section[]>(paths.sections)) || [];
  const existingTitles = new Set(existing.map((section) => section.title));
  let importedCount = 0;
  for (const section of parsed) {
    if (existingTitles.has(section.title)) {
      continue;
    }
    section.id = nextSectionId(existing);
    section.status = "pending";
    section.attempts = 0;
    section.verified_at = null;
    section.last_summary = "";
    section.last_review = "";
    section.current_step = "";
    existing.push(section);
    existingTitles.add(section.title);
    importedCount += 1;
  }
  if (importedCount > 0) {
    await writeJson(paths.sections, existing.map(ensureSectionDefaults));
  }
  return importedCount;
}

async function runExplorationPass(config: TnsConfig, paths: ReturnType<typeof statePaths>, manifest: Awaited<ReturnType<typeof loadManifest>>, sections: Section[]): Promise<RunLoopResult | null> {
  const settings = explorationSettings(config);
  if (!settings.enabled) {
    return null;
  }
  const converged = sections.length > 0 && sections.every((section) => ensureSectionDefaults(section).status === "done");
  if (!converged) {
    return null;
  }

  const window = currentWindow(manifest);
  const state = await loadExplorationState(paths);
  const roundsRun = state.window_index === window.index ? state.rounds_run : 0;
  if (roundsRun >= settings.max_rounds_per_window) {
    return null;
  }

  const permissionProfile = resolveDefaultPermissionProfile(config);
  const approvals = await loadApprovals(paths);
  const missingApproval = missingApprovalTag(approvals, permissionProfile);
  if (missingApproval) {
    await recordApprovalRequest(paths, {
      tag: missingApproval,
      section_id: "exploration",
      section_title: "Exploration review",
      step: "exploration",
      profile: permissionProfile.profile_name,
      reason: `Approval tag '${missingApproval}' is required for exploration profile '${permissionProfile.profile_name}'.`,
    });
    await writeJson(paths.freeze, {
      reason: `approval_required:${missingApproval}`,
      at: iso(utcNow()),
      window: window.index,
      approval_tag: missingApproval,
      profile: permissionProfile.profile_name,
      section: "exploration",
      step: "exploration",
    });
    await appendJsonl(paths.activity, {
      event: "approval_required",
      at: iso(utcNow()),
      section: "exploration",
      step: "exploration",
      approval_tag: missingApproval,
      profile: permissionProfile.profile_name,
      reason: `Approval tag '${missingApproval}' is required for exploration profile '${permissionProfile.profile_name}'.`,
    });
    return { ran: false };
  }

  const injectionProfile = resolveInjectionProfile(config, "exploration", null, "exploration");
  const runId = `exploration-${Date.now()}`;
  const pluginSandbox = await preparePluginSandbox(paths, injectionProfile, runId, config);
  const prompt = await buildExplorationPrompt(config, paths, sections, settings.allow_taskx, settings.taskx_filename, roundsRun + 1, settings.max_rounds_per_window, permissionProfile, injectionProfile);
  const agentConfig = configForAgentMode(config, "exploration");
  await appendJsonl(paths.activity, {
    event: "exploration_start",
    at: iso(utcNow()),
    round: roundsRun + 1,
    permission_profile: permissionProfile.profile_name,
    approval_tag: permissionProfile.approval_tag,
  });
  await heartbeatRuntime(paths, { current_section: "exploration", current_step: "review", sleep_until: null, ...clearAgentRuntimeFields() });

  let result: ExplorationResult;
  try {
    const agentResult = await runAgent(agentConfig, paths.workspace, settings.agent, schemaByName("exploration"), prompt, {
      onHeartbeat: async (snapshot) => {
        await heartbeatRuntime(paths, {
          current_section: "exploration",
          current_step: "review",
          current_agent: snapshot.agent,
          agent_pid: snapshot.pid,
          agent_started_at: snapshot.started_at,
          agent_deadline_at: snapshot.deadline_at,
          sleep_until: null,
        });
      },
      plugin_dir: pluginSandbox.plugin_root,
      extra_add_dirs: pluginSandbox.add_dirs,
      paths,
      metadata: {
        run_id: runId,
        agent_mode: "exploration",
        section_id: "exploration",
        step: "exploration",
        injection_profile: injectionProfile.profile_name,
        injected_skills: [...pluginSandbox.skills, ...pluginSandbox.external_skill_paths.map((item) => item.split("/").pop() || item)],
      },
      permissions: {
        permission_mode: permissionProfile.permission_mode,
        allowed_tools: permissionProfile.allowed_tools,
        disallowed_tools: permissionProfile.disallowed_tools,
      },
    });
    result = agentResult.payload as unknown as ExplorationResult;
  } catch (exc: unknown) {
    const message = String(exc);
    if (looksLikeRetryableError(message)) {
      await appendJsonl(paths.activity, {
        event: message.toLowerCase().includes("watchdog timeout") ? "agent_watchdog_timeout" : "transient_error",
        at: iso(utcNow()),
        section: "exploration",
        step: "review",
        error: message,
      });
      await heartbeatRuntime(paths, { current_section: "", current_step: "", ...clearAgentRuntimeFields() });
      return { ran: false };
    }
    throw exc;
  } finally {
    await gcPluginSandbox(paths, runId, pluginSandbox.plugin_root);
  }

  ensureFilesTouchedStayInWorkspace(paths.workspace, result.files_touched || []);
  appendHandoff(paths.handoff, "Exploration", result as unknown as Record<string, unknown>, "exploration");
  await appendJsonl(paths.activity, {
    event: "exploration_end",
    at: iso(utcNow()),
    section: "exploration",
    step: "review",
    result,
  });

  const nextState: ExplorationState = {
    window_index: window.index,
    rounds_run: roundsRun + 1,
    last_outcome: result.outcome,
    last_summary: result.summary,
    last_taskx_path: result.taskx_created ? result.taskx_path : null,
    updated_at: iso(utcNow()),
  };

  if (result.outcome === "blocked") {
    await saveExplorationState(paths, nextState);
    await appendJsonl(paths.activity, {
      event: "exploration_blocked",
      at: iso(utcNow()),
      blocker: result.blocker,
      summary: result.summary,
    });
    await heartbeatRuntimeSerial(paths, { current_section: "", current_step: "", sleep_until: null, ...clearAgentRuntimeFields() });
    return { ran: false };
  }

  if (result.taskx_created && settings.allow_taskx) {
    const taskxPath = resolveFsPath(result.taskx_path || settings.taskx_filename, paths.workspace);
    if (!(await pathExists(taskxPath))) {
      throw new Error(`exploration reported taskx_created but file was not found: ${result.taskx_path}`);
    }
    const imported = await importTaskxSections(paths, taskxPath);
    nextState.last_taskx_path = taskxPath;
    await saveExplorationState(paths, nextState);
    await appendJsonl(paths.activity, {
      event: "exploration_taskx_imported",
      at: iso(utcNow()),
      taskx_path: taskxPath,
      imported_sections: imported,
      summary: result.summary,
    });
    await rebuildArtifactIndex(paths);
    await heartbeatRuntimeSerial(paths, { current_section: "", current_step: "", sleep_until: null, ...clearAgentRuntimeFields() });
    return { ran: imported > 0 };
  }

  await saveExplorationState(paths, nextState);
  await rebuildArtifactIndex(paths);
  await heartbeatRuntime(paths, { current_section: "", current_step: "", sleep_until: null, ...clearAgentRuntimeFields() });
  return { ran: result.outcome === "refined" };
}

async function normalizeFreeze(paths: ReturnType<typeof statePaths>): Promise<{ blocked: boolean; nextWakeAt?: string | null }> {
  if (!(await pathExists(paths.freeze))) {
    return { blocked: false };
  }
  const freeze = await readJson<Record<string, unknown>>(paths.freeze);
  if (!freeze || typeof freeze !== "object") {
    await removePath(paths.freeze);
    await appendJsonl(paths.activity, { event: "stale_freeze_cleared", at: iso(utcNow()) });
    return { blocked: false };
  }
  const until = typeof freeze.until === "string" ? Date.parse(freeze.until) : NaN;
  if (!Number.isNaN(until) && until <= Date.now()) {
    await removePath(paths.freeze);
    await appendJsonl(paths.activity, { event: "freeze_expired", at: iso(utcNow()) });
    return { blocked: false };
  }
  return {
    blocked: true,
    nextWakeAt: !Number.isNaN(until) ? new Date(until).toISOString() : null,
  };
}

async function loadCompiledParallelPlan(paths: ReturnType<typeof statePaths>): Promise<FsmParallelPlan | null> {
  const compiled = await readJson<Record<string, unknown>>(paths.compiled_program);
  const inputs = compiled?.inputs && typeof compiled.inputs === "object" && !Array.isArray(compiled.inputs)
    ? compiled.inputs as Record<string, unknown>
    : {};
  const orchestration = compiled?.orchestration && typeof compiled.orchestration === "object" && !Array.isArray(compiled.orchestration)
    ? compiled.orchestration as Record<string, unknown>
    : {};
  const candidate = orchestration.parallel_plan ?? inputs.parallel_plan;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const plan = candidate as Partial<FsmParallelPlan>;
  if (!plan.enabled || !Array.isArray(plan.batches)) return null;
  return plan as FsmParallelPlan;
}

function sectionReadyForParallel(section: Section, maxAttempts: number): boolean {
  ensureSectionDefaults(section);
  if (section.status !== "pending" && section.status !== "needs_fix") return false;
  return section.attempts < maxAttempts || section.status === "needs_fix";
}

function selectParallelBatch(plan: FsmParallelPlan, sections: Section[], maxAttempts: number): FsmParallelPlanItem[] {
  const byId = new Map(sections.map((section) => [section.id, ensureSectionDefaults(section)]));
  const done = new Set(sections.filter((section) => ensureSectionDefaults(section).status === "done").map((section) => section.id));
  for (const batch of plan.batches) {
    const states = batch.states ?? [];
    if (states.length === 0) continue;
    const blockedByDeps = states.some((item) => !item.depends_on.every((dep) => done.has(dep)));
    if (blockedByDeps) continue;
    const runnable = states.filter((item) => {
      const section = byId.get(item.state);
      return section ? sectionReadyForParallel(section, maxAttempts) : false;
    });
    if (runnable.length > 1) {
      return runnable.slice(0, Math.max(1, plan.max_threads));
    }
    if (runnable.length === 1) {
      return [];
    }
    const unfinished = states.some((item) => {
      const section = byId.get(item.state);
      return section && section.status !== "done" && section.status !== "blocked";
    });
    if (unfinished) return [];
  }
  return [];
}

async function updateSectionOnly(paths: ReturnType<typeof statePaths>, sectionId: string, updater: (section: Section) => void): Promise<Section> {
  return withStateMutation(async () => {
    const sections = ((await readJson<Section[]>(paths.sections)) || []).map(ensureSectionDefaults);
    const section = sections.find((item) => item.id === sectionId);
    if (!section) throw new Error(`section not found: ${sectionId}`);
    updater(section);
    await writeJson(paths.sections, sections);
    return { ...section };
  });
}

async function appendReviewRecord(paths: ReturnType<typeof statePaths>, review: ReviewRecord): Promise<void> {
  await withStateMutation(async () => {
    const reviews: ReviewRecord[] = (await readJson<ReviewRecord[]>(paths.reviews)) || [];
    reviews.push(review);
    await writeJson(paths.reviews, reviews);
  });
}

async function requestApprovalForSection(
  config: TnsConfig,
  paths: ReturnType<typeof statePaths>,
  section: Section,
  step: string,
  permissionProfile: ResolvedPermissionProfile,
  approvalTag: string
): Promise<void> {
  const reason = `Approval tag '${approvalTag}' is required for profile '${permissionProfile.profile_name}' before ${section.title} (${step}) can run.`;
  await updateSectionOnly(paths, section.id, (item) => {
    item.status = "pending";
    item.last_review = reason;
    item.current_step = "";
  });
  await recordApprovalRequest(paths, {
    tag: approvalTag,
    section_id: section.id,
    section_title: section.title,
    step,
    profile: permissionProfile.profile_name,
    reason,
  });
  await withStateMutation(async () => {
    await writeJson(paths.freeze, {
      reason: `approval_required:${approvalTag}`,
      at: iso(utcNow()),
      window: currentWindow(await loadManifest(paths)).index,
      approval_tag: approvalTag,
      profile: permissionProfile.profile_name,
      section: section.id,
      step,
    });
  });
  await appendJsonl(paths.activity, {
    event: "approval_required",
    at: iso(utcNow()),
    section: section.id,
    step,
    approval_tag: approvalTag,
    profile: permissionProfile.profile_name,
    reason,
  });
}

async function executeParallelSectionWorkflow(
  config: TnsConfig,
  paths: ReturnType<typeof statePaths>,
  sectionId: string,
  policies: ReturnType<typeof policySettings>
): Promise<RunLoopResult> {
  let selected = await updateSectionOnly(paths, sectionId, (section) => {
    ensureSectionDefaults(section);
  });
  const wf = workflowSettings(config);
  const nodeMap = new Map(wf.agents.map((n) => [n.id, n]));
  let currentStep = selected.current_step || wf.entry;
  const stepResults: { node_id: string; payload: Record<string, unknown>; usage: unknown }[] = [];
  const validatorResults: ValidatorResult[] = [];
  const commandRuns: CommandRunResult[] = [];
  const priorResults: Record<string, Record<string, unknown>> = {};

  const initialPermissionProfile = resolvePermissionProfile(config, selected, currentStep);
  const approvals = await loadApprovals(paths);
  const missingApproval = missingApprovalTag(approvals, initialPermissionProfile);
  if (missingApproval) {
    await requestApprovalForSection(config, paths, selected, currentStep, initialPermissionProfile, missingApproval);
    await heartbeatRuntimeSerial(paths, { current_section: "", current_step: "", sleep_until: null, ...clearAgentRuntimeFields() });
    return { ran: false };
  }

  selected = await updateSectionOnly(paths, selected.id, (section) => {
    section.status = "in_progress";
    section.attempts = (section.attempts || 0) + 1;
    section.current_step = currentStep;
  });
  await heartbeatRuntimeSerial(paths, { current_section: `parallel:${selected.id}`, current_step: currentStep, sleep_until: null, ...clearAgentRuntimeFields() });

  try {
    for (let step = 0; step < wf.max_steps_per_run; step++) {
      const node = nodeMap.get(currentStep);
      if (!node) throw new Error(`workflow step not found: ${currentStep}`);
      const permissionProfile = resolvePermissionProfile(config, selected, currentStep);
      const latestApprovals = await loadApprovals(paths);
      const stepMissingApproval = missingApprovalTag(latestApprovals, permissionProfile);
      if (stepMissingApproval) {
        await requestApprovalForSection(config, paths, selected, currentStep, permissionProfile, stepMissingApproval);
        await heartbeatRuntimeSerial(paths, { current_section: "", current_step: "", sleep_until: null, ...clearAgentRuntimeFields() });
        return { ran: false };
      }

      const preCommands = await runStageCommandHooks(paths, config, "pre_step", selected, currentStep);
      commandRuns.push(...preCommands);
      const failedPreCommands = preCommands.filter((item) => !item.ok);
      if (failedPreCommands.length > 0) {
        const sectionForPolicy = await updateSectionOnly(paths, selected.id, (item) => Object.assign(selected, item));
        const outcome = await applyPolicyAction(
          paths,
          policyActionFor(policies, "command_failure"),
          sectionForPolicy,
          summarizeFailures(failedPreCommands.map((item) => ({ id: item.id, message: item.stderr || `exit ${item.exit_code}` }))),
          { stage: "pre_step", step: currentStep, command_sets: failedPreCommands.map((item) => item.id) }
        );
        await updateSectionOnly(paths, sectionForPolicy.id, (item) => Object.assign(item, sectionForPolicy));
        await persistSectionOutputIfEnabled(config, paths, sectionForPolicy, stepResults, validatorResults, commandRuns);
        if (outcome === "failed") throw new Error(`pre-step command hook failed: ${failedPreCommands.map((item) => item.id).join(", ")}`);
        return { ran: false };
      }

      const preValidators = await runStageValidators(paths, config, "pre_step", selected, currentStep);
      validatorResults.push(...preValidators);
      const failedPreValidators = preValidators.filter((item) => !item.ok);
      if (failedPreValidators.length > 0) {
        const sectionForPolicy = await updateSectionOnly(paths, selected.id, (item) => Object.assign(selected, item));
        const outcome = await applyPolicyAction(
          paths,
          policyActionFor(policies, "validator_failure", "pre_step"),
          sectionForPolicy,
          summarizeFailures(failedPreValidators),
          { stage: "pre_step", validator_ids: failedPreValidators.map((item) => item.id) }
        );
        await updateSectionOnly(paths, sectionForPolicy.id, (item) => Object.assign(item, sectionForPolicy));
        await persistSectionOutputIfEnabled(config, paths, sectionForPolicy, stepResults, validatorResults, commandRuns);
        if (outcome === "failed") throw new Error(`pre-step validators failed: ${failedPreValidators.map((item) => item.id).join(", ")}`);
        return { ran: false };
      }

      const schema = schemaByName(node.schema || node.id);
      const mode = currentStep === "verifier" ? "verifier" : "executor";
      const injectionProfile = await resolveManagedInjectionProfile(config, mode, selected, currentStep);
      const runId = `${selected.id}-${currentStep}-${Date.now()}`;
      const pluginSandbox = await preparePluginSandbox(paths, injectionProfile, runId, config);
      const injectedSkills = injectedSkillNames(injectionProfile);
      const prompt = await buildPrompt(paths, selected, node, priorResults, permissionProfile, injectionProfile);
      const agentConfig = configForAgentMode(config, mode);

      await appendJsonl(paths.activity, {
        event: "agent_start",
        at: iso(utcNow()),
        section: selected.id,
        step: currentStep,
        agent: node.agent,
        permission_profile: permissionProfile.profile_name,
        approval_tag: permissionProfile.approval_tag,
        injection_profile: injectionProfile.profile_name,
        injected_skills: injectedSkills,
        parallel: true,
      });

      let result: { payload: Record<string, unknown>; usage: Record<string, unknown> };
      try {
        const agentResult = await runAgent(agentConfig, paths.workspace, node.agent, schema, prompt, {
          onHeartbeat: async (snapshot) => {
            await heartbeatRuntimeSerial(paths, {
              current_section: `parallel:${selected.id}`,
              current_step: currentStep,
              current_agent: snapshot.agent,
              agent_pid: snapshot.pid,
              agent_started_at: snapshot.started_at,
              agent_deadline_at: snapshot.deadline_at,
              sleep_until: null,
            });
          },
          plugin_dir: pluginSandbox.plugin_root,
          extra_add_dirs: pluginSandbox.add_dirs,
          paths,
          metadata: {
            run_id: runId,
            agent_mode: mode,
            section_id: selected.id,
            step: currentStep,
            injection_profile: injectionProfile.profile_name,
            injected_skills: injectedSkills,
          },
          permissions: {
            permission_mode: permissionProfile.permission_mode,
            allowed_tools: permissionProfile.allowed_tools,
            disallowed_tools: permissionProfile.disallowed_tools,
          },
        });
        result = { payload: agentResult.payload as unknown as Record<string, unknown>, usage: agentResult.usage as unknown as Record<string, unknown> };
      } catch (exc: unknown) {
        const message = String(exc);
        if (looksLikeUsageLimitError(message)) {
          await appendJsonl(paths.activity, { event: "usage_limit_error", at: iso(utcNow()), section: selected.id, error: message });
          await updateSectionOnly(paths, selected.id, (section) => {
            section.status = "pending";
            section.last_review = "Recovered after usage limit.";
          });
          const manifest = await loadManifest(paths);
          const until = currentWindow(manifest).end.toISOString();
          await withStateMutation(async () => {
            await writeJson(paths.freeze, { reason: `usage_limit: ${message}`, at: iso(utcNow()), until, window: currentWindow(manifest).index });
          });
          return { ran: false, nextWakeAt: until };
        }
        if (looksLikeRetryableError(message)) {
          await appendJsonl(paths.activity, { event: "transient_error", at: iso(utcNow()), section: selected.id, step: currentStep, error: message });
          await updateSectionOnly(paths, selected.id, (section) => {
            section.status = "needs_fix";
            section.last_review = `Transient error (will retry): ${message.slice(0, 200)}`;
          });
          return { ran: false };
        }
        throw exc;
      } finally {
        await gcPluginSandbox(paths, runId, pluginSandbox.plugin_root);
      }

      const { payload, usage } = result;
      const filesTouched = Array.isArray(payload.files_touched) ? payload.files_touched.filter((item): item is string => typeof item === "string") : [];
      ensureFilesTouchedStayInWorkspace(paths.workspace, filesTouched);
      priorResults[currentStep] = payload;
      stepResults.push({ node_id: currentStep, payload, usage });
      appendHandoff(paths.handoff, currentStep.charAt(0).toUpperCase() + currentStep.slice(1), payload, selected.id);
      await appendJsonl(paths.activity, { event: "agent_end", at: iso(utcNow()), section: selected.id, step: currentStep, agent: node.agent, result: payload, usage, parallel: true });

      const postCommands = await runStageCommandHooks(paths, config, "post_step", selected, currentStep);
      commandRuns.push(...postCommands);
      const failedPostCommands = postCommands.filter((item) => !item.ok);
      if (failedPostCommands.length > 0) {
        const sectionForPolicy = await updateSectionOnly(paths, selected.id, (item) => Object.assign(selected, item));
        const outcome = await applyPolicyAction(
          paths,
          policyActionFor(policies, "command_failure"),
          sectionForPolicy,
          summarizeFailures(failedPostCommands.map((item) => ({ id: item.id, message: item.stderr || `exit ${item.exit_code}` }))),
          { stage: "post_step", step: currentStep, command_sets: failedPostCommands.map((item) => item.id) }
        );
        await updateSectionOnly(paths, sectionForPolicy.id, (item) => Object.assign(item, sectionForPolicy));
        await persistSectionOutputIfEnabled(config, paths, sectionForPolicy, stepResults, validatorResults, commandRuns);
        if (outcome === "failed") throw new Error(`post-step command hook failed: ${failedPostCommands.map((item) => item.id).join(", ")}`);
        return { ran: false };
      }

      const postValidators = await runStageValidators(paths, config, "post_step", selected, currentStep);
      validatorResults.push(...postValidators);
      const failedPostValidators = postValidators.filter((item) => !item.ok);
      if (failedPostValidators.length > 0) {
        const sectionForPolicy = await updateSectionOnly(paths, selected.id, (item) => Object.assign(selected, item));
        const outcome = await applyPolicyAction(
          paths,
          policyActionFor(policies, "validator_failure", "post_step"),
          sectionForPolicy,
          summarizeFailures(failedPostValidators),
          { stage: "post_step", step: currentStep, validator_ids: failedPostValidators.map((item) => item.id) }
        );
        await updateSectionOnly(paths, sectionForPolicy.id, (item) => Object.assign(item, sectionForPolicy));
        await persistSectionOutputIfEnabled(config, paths, sectionForPolicy, stepResults, validatorResults, commandRuns);
        if (outcome === "failed") throw new Error(`post-step validators failed: ${failedPostValidators.map((item) => item.id).join(", ")}`);
        return { ran: false };
      }

      const transition = firstMatchingTransition(payload, node);
      const localReviews: ReviewRecord[] = [];
      const transitioned = { ...selected };
      applyTransitionToSection([transitioned], localReviews, transitioned, payload, transition, currentStep);
      selected = await updateSectionOnly(paths, selected.id, (section) => Object.assign(section, transitioned));
      for (const review of localReviews) {
        await appendReviewRecord(paths, review);
      }
      currentStep = selected.current_step || "";
      await heartbeatRuntimeSerial(paths, { current_section: `parallel:${selected.id}`, current_step: currentStep, ...clearAgentRuntimeFields() });
      if (transition.end || !currentStep) break;
    }

    selected = await updateSectionOnly(paths, selected.id, (section) => {
      if (section.status === "in_progress") {
        section.status = "needs_fix";
        section.last_review = "Workflow exceeded max_steps_per_run.";
      }
    });
    const postRunValidators = await runStageValidators(paths, config, "post_run", selected, selected.current_step || "post_run");
    validatorResults.push(...postRunValidators);
    const failedPostRunValidators = postRunValidators.filter((item) => !item.ok);
    if (failedPostRunValidators.length > 0) {
      const outcome = await applyPolicyAction(
        paths,
        policyActionFor(policies, "validator_failure", "post_run"),
        selected,
        summarizeFailures(failedPostRunValidators),
        { stage: "post_run", validator_ids: failedPostRunValidators.map((item) => item.id) }
      );
      await updateSectionOnly(paths, selected.id, (section) => Object.assign(section, selected));
      await persistSectionOutputIfEnabled(config, paths, selected, stepResults, validatorResults, commandRuns);
      if (outcome === "failed") throw new Error(`post-run validators failed: ${failedPostRunValidators.map((item) => item.id).join(", ")}`);
      return { ran: false };
    }
    await persistSectionOutputIfEnabled(config, paths, selected, stepResults, validatorResults, commandRuns);
  } catch (exc: unknown) {
    const message = String(exc).slice(0, 500);
    await updateSectionOnly(paths, selected.id, (section) => {
      if (section.status === "in_progress") {
        section.status = "needs_fix";
        section.last_review = `Run error (will retry): ${message}`;
        section.current_step = "";
      }
    });
    await withStateMutation(async () => {
      const diagnostics = await readJson<Record<string, unknown>>(paths.diagnostics, {});
      await writeJson(paths.diagnostics, {
        ...(diagnostics ?? {}),
        updated_at: iso(utcNow()),
        last_error: message,
      });
    });
    await appendJsonl(paths.activity, { event: "run_error", at: iso(utcNow()), section: selected.id, error: message, parallel: true });
    return { ran: false };
  }

  return { ran: true };
}

async function runParallelBatchIfReady(
  config: TnsConfig,
  paths: ReturnType<typeof statePaths>,
  sections: Section[],
  maxAttempts: number,
  policies: ReturnType<typeof policySettings>
): Promise<RunLoopResult | null> {
  const plan = await loadCompiledParallelPlan(paths);
  if (!plan) return null;
  const runnable = selectParallelBatch(plan, sections, maxAttempts);
  if (runnable.length <= 1) return null;

  const wf = workflowSettings(config);
  const approvals = await loadApprovals(paths);
  const byId = new Map(sections.map((section) => [section.id, ensureSectionDefaults(section)]));
  for (const item of runnable) {
    const section = byId.get(item.state);
    if (!section) continue;
    const step = section.current_step || wf.entry;
    const permissionProfile = resolvePermissionProfile(config, section, step);
    const missingApproval = missingApprovalTag(approvals, permissionProfile);
    if (missingApproval) {
      await requestApprovalForSection(config, paths, section, step, permissionProfile, missingApproval);
      await heartbeatRuntimeSerial(paths, { current_section: "", current_step: "", sleep_until: null, ...clearAgentRuntimeFields() });
      return { ran: false };
    }
  }

  await appendJsonl(paths.activity, {
    event: "parallel_batch_start",
    at: iso(utcNow()),
    states: runnable.map((item) => item.state),
    max_threads: plan.max_threads,
  });
  await heartbeatRuntimeSerial(paths, { current_section: `parallel:${runnable.map((item) => item.state).join(",")}`, current_step: "batch", sleep_until: null, ...clearAgentRuntimeFields() });

  const settled = await Promise.allSettled(runnable.map((item) => executeParallelSectionWorkflow(config, paths, item.state, policies)));
  await appendJsonl(paths.activity, {
    event: "parallel_batch_end",
    at: iso(utcNow()),
    results: settled.map((result, index) => ({
      state: runnable[index].state,
      status: result.status,
      ran: result.status === "fulfilled" ? result.value.ran : false,
      error: result.status === "rejected" ? String(result.reason).slice(0, 500) : null,
    })),
  });
  await rebuildArtifactIndex(paths);
  await heartbeatRuntimeSerial(paths, { current_section: "", current_step: "", sleep_until: null, ...clearAgentRuntimeFields() });
  const nextWakeAt = settled
    .filter((result): result is PromiseFulfilledResult<RunLoopResult> => result.status === "fulfilled")
    .map((result) => result.value.nextWakeAt)
    .find((item): item is string => typeof item === "string");
  return {
    ran: settled.some((result) => result.status === "fulfilled" && result.value.ran),
    nextWakeAt: nextWakeAt ?? null,
  };
}

async function runOnce(config: TnsConfig, paths: ReturnType<typeof statePaths>): Promise<RunLoopResult> {
  const policies = policySettings(config);
  const freezeState = await normalizeFreeze(paths);
  if (freezeState.blocked) {
    await heartbeatRuntime(paths, { current_section: "", current_step: "", sleep_until: freezeState.nextWakeAt ?? null, ...clearAgentRuntimeFields() });
    return { ran: false, nextWakeAt: freezeState.nextWakeAt ?? null };
  }

  const preflightCommands = await runStageCommandHooks(paths, config, "preflight", null, "preflight");
  const failedPreflightCommands = preflightCommands.filter((item) => !item.ok);
  if (failedPreflightCommands.length > 0) {
    const outcome = await applyPolicyAction(
      paths,
      policyActionFor(policies, "command_failure"),
      null,
      summarizeFailures(failedPreflightCommands.map((item) => ({ id: item.id, message: item.stderr || `exit ${item.exit_code}` }))),
      { stage: "preflight", command_sets: failedPreflightCommands.map((item) => item.id) }
    );
    if (outcome === "failed") {
      throw new Error(`preflight command hooks failed: ${failedPreflightCommands.map((item) => item.id).join(", ")}`);
    }
    return { ran: false };
  }

  const preflight = await runWorkspacePreflight(paths, config);
  const preflightFailures = preflight.filter((item) => !item.ok);
  if (preflightFailures.length > 0) {
    const outcome = await applyPolicyAction(
      paths,
      policyActionFor(policies, "preflight_failure"),
      null,
      summarizeFailures(preflightFailures),
      { stage: "preflight", validator_ids: preflightFailures.map((item) => item.id) }
    );
    if (outcome === "failed") {
      throw new Error(`preflight failed: ${summarizeFailures(preflightFailures)}`);
    }
    return { ran: false };
  }

  // Recover in-progress sections
  let sections = (await readJson<Section[]>(paths.sections)) || [];
  if (recoverInProgressSections(sections)) {
    await writeJson(paths.sections, sections);
    await appendJsonl(paths.activity, { event: "recover_in_progress", at: iso(utcNow()) });
  }

  sections = sections.map(ensureSectionDefaults);
  const maxAttempts = attemptsSettings(config).max_per_section;
  const recovery = await applyRuntimeRecoveryDecisions(config, paths, sections, maxAttempts);
  sections = recovery.sections;
  if (recovery.changed) {
    await writeJson(paths.sections, sections);
    if (recovery.recompiled) {
      await heartbeatRuntime(paths, { current_section: "", current_step: "", sleep_until: null, ...clearAgentRuntimeFields() });
      return { ran: false };
    }
  }
  const parallelResult = await runParallelBatchIfReady(config, paths, sections, maxAttempts, policies);
  if (parallelResult) {
    return parallelResult;
  }
  const selected = selectSection(sections, maxAttempts);

  if (!selected) {
    const explorationResult = await runExplorationPass(config, paths, await loadManifest(paths), sections);
    if (explorationResult) {
      return explorationResult;
    }
    await appendJsonl(paths.activity, { event: "complete", at: iso(utcNow()) });
    await heartbeatRuntime(paths, { current_section: "", current_step: "", sleep_until: null, ...clearAgentRuntimeFields() });
    return { ran: false };
  }

  const wf = workflowSettings(config);
  const nodeMap = new Map(wf.agents.map((n) => [n.id, n]));
  let currentStep = selected.current_step || wf.entry;
  const initialPermissionProfile = resolvePermissionProfile(config, selected, currentStep);
  const approvals = await loadApprovals(paths);
  const missingApproval = missingApprovalTag(approvals, initialPermissionProfile);
  if (missingApproval) {
    const reason = `Approval tag '${missingApproval}' is required for profile '${initialPermissionProfile.profile_name}' before ${selected.title} (${currentStep}) can run.`;
    selected.last_review = reason;
    await writeJson(paths.sections, sections);
    await recordApprovalRequest(paths, {
      tag: missingApproval,
      section_id: selected.id,
      section_title: selected.title,
      step: currentStep,
      profile: initialPermissionProfile.profile_name,
      reason,
    });
    await writeJson(paths.freeze, {
      reason: `approval_required:${missingApproval}`,
      at: iso(utcNow()),
      window: currentWindow(await loadManifest(paths)).index,
      approval_tag: missingApproval,
      profile: initialPermissionProfile.profile_name,
      section: selected.id,
      step: currentStep,
    });
    await appendJsonl(paths.activity, {
      event: "approval_required",
      at: iso(utcNow()),
      section: selected.id,
      step: currentStep,
      approval_tag: missingApproval,
      profile: initialPermissionProfile.profile_name,
      reason,
    });
    await heartbeatRuntime(paths, { current_section: "", current_step: "", sleep_until: null, ...clearAgentRuntimeFields() });
    return { ran: false };
  }
  const stepResults: { node_id: string; payload: Record<string, unknown>; usage: unknown }[] = [];
  const validatorResults: ValidatorResult[] = [];
  const commandRuns: CommandRunResult[] = [];
  const priorResults: Record<string, Record<string, unknown>> = {};

  selected.status = "in_progress";
  selected.attempts = (selected.attempts || 0) + 1;
  selected.current_step = currentStep;
  await writeJson(paths.sections, sections);
  await heartbeatRuntime(paths, { current_section: selected.id, current_step: currentStep, sleep_until: null, ...clearAgentRuntimeFields() });

  try {
    for (let step = 0; step < wf.max_steps_per_run; step++) {
      const node = nodeMap.get(currentStep);
      if (!node) throw new Error(`workflow step not found: ${currentStep}`);
      const permissionProfile = resolvePermissionProfile(config, selected, currentStep);
      const latestApprovals = await loadApprovals(paths);
      const stepMissingApproval = missingApprovalTag(latestApprovals, permissionProfile);
      if (stepMissingApproval) {
        const reason = `Approval tag '${stepMissingApproval}' is required for profile '${permissionProfile.profile_name}' before ${selected.title} (${currentStep}) can run.`;
        sections = (await readJson<Section[]>(paths.sections)) || [];
        updateSection(sections, selected.id, {
          status: "pending",
          last_review: reason,
        });
        await writeJson(paths.sections, sections);
        await recordApprovalRequest(paths, {
          tag: stepMissingApproval,
          section_id: selected.id,
          section_title: selected.title,
          step: currentStep,
          profile: permissionProfile.profile_name,
          reason,
        });
        await writeJson(paths.freeze, {
          reason: `approval_required:${stepMissingApproval}`,
          at: iso(utcNow()),
          window: currentWindow(await loadManifest(paths)).index,
          approval_tag: stepMissingApproval,
          profile: permissionProfile.profile_name,
          section: selected.id,
          step: currentStep,
        });
        await appendJsonl(paths.activity, {
          event: "approval_required",
          at: iso(utcNow()),
          section: selected.id,
          step: currentStep,
          approval_tag: stepMissingApproval,
          profile: permissionProfile.profile_name,
          reason,
        });
        await heartbeatRuntime(paths, { current_section: "", current_step: "", sleep_until: null, ...clearAgentRuntimeFields() });
        return { ran: false };
      }

      const preCommands = await runStageCommandHooks(paths, config, "pre_step", selected, currentStep);
      commandRuns.push(...preCommands);
      const failedPreCommands = preCommands.filter((item) => !item.ok);
      if (failedPreCommands.length > 0) {
        const outcome = await applyPolicyAction(
          paths,
          policyActionFor(policies, "command_failure"),
          selected,
          summarizeFailures(failedPreCommands.map((item) => ({ id: item.id, message: item.stderr || `exit ${item.exit_code}` }))),
          { stage: "pre_step", step: currentStep, command_sets: failedPreCommands.map((item) => item.id) }
        );
        await writeJson(paths.sections, sections);
        await persistSectionOutputIfEnabled(config, paths, selected, stepResults, validatorResults, commandRuns);
        await heartbeatRuntime(paths, { current_section: "", current_step: "", sleep_until: null, ...clearAgentRuntimeFields() });
        if (outcome === "failed") {
          throw new Error(`pre-step command hook failed: ${failedPreCommands.map((item) => item.id).join(", ")}`);
        }
        return { ran: false };
      }

      const preValidators = await runStageValidators(paths, config, "pre_step", selected, currentStep);
      validatorResults.push(...preValidators);
      const failedPreValidators = preValidators.filter((item) => !item.ok);
      if (failedPreValidators.length > 0) {
        const outcome = await applyPolicyAction(
          paths,
          policyActionFor(policies, "validator_failure", "pre_step"),
          selected,
          summarizeFailures(failedPreValidators),
          { stage: "pre_step", step: currentStep, validator_ids: failedPreValidators.map((item) => item.id) }
        );
        await writeJson(paths.sections, sections);
        await persistSectionOutputIfEnabled(config, paths, selected, stepResults, validatorResults, commandRuns);
        await heartbeatRuntime(paths, { current_section: "", current_step: "", sleep_until: null, ...clearAgentRuntimeFields() });
        if (outcome === "failed") {
          throw new Error(`pre-step validators failed: ${failedPreValidators.map((item) => item.id).join(", ")}`);
        }
        return { ran: false };
      }

      const schema = schemaByName(node.schema || node.id);
      const mode = currentStep === "verifier" ? "verifier" : "executor";
      const injectionProfile = await resolveManagedInjectionProfile(config, mode, selected, currentStep);
      const runId = `${selected.id}-${currentStep}-${Date.now()}`;
      const pluginSandbox = await preparePluginSandbox(paths, injectionProfile, runId, config);
      const injectedSkills = injectedSkillNames(injectionProfile);
      const prompt = await buildPrompt(paths, selected, node, priorResults, permissionProfile, injectionProfile);
      const agentConfig = configForAgentMode(config, mode);

      await appendJsonl(paths.activity, {
        event: "agent_start",
        at: iso(utcNow()),
        section: selected.id,
        step: currentStep,
        agent: node.agent,
        permission_profile: permissionProfile.profile_name,
        approval_tag: permissionProfile.approval_tag,
        injection_profile: injectionProfile.profile_name,
        injected_skills: injectedSkills,
        auto_skills: injectionProfile.auto_skills ?? [],
        skill_matches: (injectionProfile.skill_matches ?? []).map((match) => ({
          name: match.name,
          score: match.score,
          path: match.entry.path,
          matched_terms: match.matched_terms,
        })),
      });
      await heartbeatRuntime(paths, { current_section: selected.id, current_step: currentStep });

      let result: { payload: Record<string, unknown>; usage: Record<string, unknown> };
      try {
        const agentResult = await runAgent(agentConfig, paths.workspace, node.agent, schema, prompt, {
          onHeartbeat: async (snapshot) => {
            await heartbeatRuntime(paths, {
              current_section: selected.id,
              current_step: currentStep,
              current_agent: snapshot.agent,
              agent_pid: snapshot.pid,
              agent_started_at: snapshot.started_at,
              agent_deadline_at: snapshot.deadline_at,
              sleep_until: null,
            });
          },
          plugin_dir: pluginSandbox.plugin_root,
          extra_add_dirs: pluginSandbox.add_dirs,
          paths,
          metadata: {
            run_id: runId,
            agent_mode: mode,
            section_id: selected.id,
            step: currentStep,
            injection_profile: injectionProfile.profile_name,
            injected_skills: injectedSkills,
          },
          permissions: {
            permission_mode: permissionProfile.permission_mode,
            allowed_tools: permissionProfile.allowed_tools,
            disallowed_tools: permissionProfile.disallowed_tools,
          },
        });
        result = { payload: agentResult.payload as unknown as Record<string, unknown>, usage: agentResult.usage as unknown as Record<string, unknown> };
      } catch (exc: unknown) {
        const message = String(exc);
        if (looksLikeUsageLimitError(message)) {
          await appendJsonl(paths.activity, { event: "usage_limit_error", at: iso(utcNow()), section: selected.id, error: message });
          sections = (await readJson<Section[]>(paths.sections)) || [];
          updateSection(sections, selected.id, { status: "pending", last_review: "Recovered after usage limit." });
          await writeJson(paths.sections, sections);
          const manifest = await loadManifest(paths);
          const until = currentWindow(manifest).end.toISOString();
          await writeJson(paths.freeze, {
            reason: `usage_limit: ${message}`,
            at: iso(utcNow()),
            until,
            window: currentWindow(manifest).index,
          });
          await appendJsonl(paths.activity, { event: "freeze", at: iso(utcNow()), section: selected.id, reason: `usage_limit: ${message}`, until });
          await heartbeatRuntime(paths, { current_section: selected.id, current_step: currentStep, sleep_until: until, ...clearAgentRuntimeFields() });
          return { ran: false, nextWakeAt: until };
        }
        if (looksLikeRetryableError(message)) {
          await appendJsonl(paths.activity, {
            event: message.toLowerCase().includes("watchdog timeout") ? "agent_watchdog_timeout" : "transient_error",
            at: iso(utcNow()),
            section: selected.id,
            step: currentStep,
            error: message,
          });
          sections = (await readJson<Section[]>(paths.sections)) || [];
          updateSection(sections, selected.id, { status: "needs_fix", last_review: `Transient error (will retry): ${message.slice(0, 200)}` });
          await writeJson(paths.sections, sections);
          await heartbeatRuntime(paths, { current_section: selected.id, current_step: currentStep, ...clearAgentRuntimeFields() });
          return { ran: false };
        }
        throw exc;
      } finally {
        await gcPluginSandbox(paths, runId, pluginSandbox.plugin_root);
      }

      const { payload, usage } = result;
      const filesTouched = Array.isArray(payload.files_touched)
        ? payload.files_touched.filter((item): item is string => typeof item === "string")
        : [];
      try {
        ensureFilesTouchedStayInWorkspace(paths.workspace, filesTouched);
      } catch (error: unknown) {
        const outcome = await applyPolicyAction(
          paths,
          policyActionFor(policies, "outside_workspace_violation"),
          selected,
          String(error),
          { stage: "post_step", step: currentStep }
        );
        await writeJson(paths.sections, sections);
        await persistSectionOutputIfEnabled(config, paths, selected, stepResults, validatorResults, commandRuns);
        await heartbeatRuntime(paths, { current_section: "", current_step: "", sleep_until: null, ...clearAgentRuntimeFields() });
        if (outcome === "failed") {
          throw error;
        }
        return { ran: false };
      }
      priorResults[currentStep] = payload;
      stepResults.push({ node_id: currentStep, payload, usage });

      appendHandoff(paths.handoff, currentStep.charAt(0).toUpperCase() + currentStep.slice(1), payload, selected.id);

      await appendJsonl(paths.activity, {
        event: "agent_end",
        at: iso(utcNow()),
        section: selected.id,
        step: currentStep,
        agent: node.agent,
        result: payload,
        usage,
      });
      await heartbeatRuntime(paths, {
        current_section: selected.id,
        current_step: currentStep,
        ...clearAgentRuntimeFields(),
      });

      const postCommands = await runStageCommandHooks(paths, config, "post_step", selected, currentStep);
      commandRuns.push(...postCommands);
      const failedPostCommands = postCommands.filter((item) => !item.ok);
      if (failedPostCommands.length > 0) {
        sections = (await readJson<Section[]>(paths.sections)) || [];
        const sectionForPolicy = sections.find((s) => s.id === selected.id) || selected;
        const outcome = await applyPolicyAction(
          paths,
          policyActionFor(policies, "command_failure"),
          sectionForPolicy,
          summarizeFailures(failedPostCommands.map((item) => ({ id: item.id, message: item.stderr || `exit ${item.exit_code}` }))),
          { stage: "post_step", step: currentStep, command_sets: failedPostCommands.map((item) => item.id) }
        );
        await writeJson(paths.sections, sections);
        await persistSectionOutputIfEnabled(config, paths, sectionForPolicy, stepResults, validatorResults, commandRuns);
        await heartbeatRuntime(paths, { current_section: "", current_step: "", sleep_until: null, ...clearAgentRuntimeFields() });
        if (outcome === "failed") {
          throw new Error(`post-step command hook failed: ${failedPostCommands.map((item) => item.id).join(", ")}`);
        }
        return { ran: false };
      }

      const postValidators = await runStageValidators(paths, config, "post_step", selected, currentStep);
      validatorResults.push(...postValidators);
      const failedPostValidators = postValidators.filter((item) => !item.ok);
      if (failedPostValidators.length > 0) {
        sections = (await readJson<Section[]>(paths.sections)) || [];
        const sectionForPolicy = sections.find((s) => s.id === selected.id) || selected;
        const outcome = await applyPolicyAction(
          paths,
          policyActionFor(policies, "validator_failure", "post_step"),
          sectionForPolicy,
          summarizeFailures(failedPostValidators),
          { stage: "post_step", step: currentStep, validator_ids: failedPostValidators.map((item) => item.id) }
        );
        await writeJson(paths.sections, sections);
        await persistSectionOutputIfEnabled(config, paths, sectionForPolicy, stepResults, validatorResults, commandRuns);
        await heartbeatRuntime(paths, { current_section: "", current_step: "", sleep_until: null, ...clearAgentRuntimeFields() });
        if (outcome === "failed") {
          throw new Error(`post-step validators failed: ${failedPostValidators.map((item) => item.id).join(", ")}`);
        }
        return { ran: false };
      }

      sections = (await readJson<Section[]>(paths.sections)) || [];
      const transition = firstMatchingTransition(payload, node);
      const reviews: ReviewRecord[] = (await readJson<ReviewRecord[]>(paths.reviews)) || [];

      const sectionInList = sections.find((s) => s.id === selected.id);
      if (!sectionInList) throw new Error(`section ${selected.id} not found after transition`);
      ensureSectionDefaults(sectionInList);

      applyTransitionToSection(sections, reviews, sectionInList, payload, transition, currentStep);
      await writeJson(paths.reviews, reviews);
      await writeJson(paths.sections, sections);

      const updatedSection = sections.find((s) => s.id === selected.id);
      if (!updatedSection) throw new Error(`section ${selected.id} not found after update`);
      currentStep = updatedSection.current_step || "";
      await heartbeatRuntime(paths, { current_section: selected.id, current_step: currentStep });

      if (transition.end || !currentStep) break;
    }

    // Reload to check status after loop
    sections = (await readJson<Section[]>(paths.sections)) || [];
    const finalSection = sections.find((s) => s.id === selected.id);
    if (finalSection && finalSection.status === "in_progress") {
      updateSection(sections, selected.id, { status: "needs_fix", last_review: "Workflow exceeded max_steps_per_run." });
      await writeJson(paths.sections, sections);
    }
    const finalForValidation = sections.find((s) => s.id === selected.id) || selected;
    const postRunValidators = await runStageValidators(paths, config, "post_run", finalForValidation, finalForValidation.current_step || "post_run");
    validatorResults.push(...postRunValidators);
    const failedPostRunValidators = postRunValidators.filter((item) => !item.ok);
    if (failedPostRunValidators.length > 0) {
      const outcome = await applyPolicyAction(
        paths,
        policyActionFor(policies, "validator_failure", "post_run"),
        finalForValidation,
        summarizeFailures(failedPostRunValidators),
        { stage: "post_run", validator_ids: failedPostRunValidators.map((item) => item.id) }
      );
      await writeJson(paths.sections, sections);
      await persistSectionOutputIfEnabled(config, paths, finalForValidation, stepResults, validatorResults, commandRuns);
      await heartbeatRuntime(paths, { current_section: "", current_step: "", sleep_until: null, ...clearAgentRuntimeFields() });
      if (outcome === "failed") {
        throw new Error(`post-run validators failed: ${failedPostRunValidators.map((item) => item.id).join(", ")}`);
      }
      return { ran: false };
    }
    await persistSectionOutputIfEnabled(config, paths, finalForValidation, stepResults, validatorResults, commandRuns);
  } catch (exc: unknown) {
    console.error(`Error in run loop: ${exc}`);
    await markRunError(paths, exc);
    return { ran: false };
  }

  await rebuildArtifactIndex(paths);
  await heartbeatRuntime(paths, { current_section: "", current_step: "", sleep_until: null, ...clearAgentRuntimeFields() });
  return { ran: true };
}

async function markRunError(paths: ReturnType<typeof statePaths>, exc: unknown): Promise<void> {
  const message = String(exc).slice(0, 500);
  const sections = (await readJson<Section[]>(paths.sections)) || [];
  let changed = false;
  for (const section of sections) {
    ensureSectionDefaults(section);
    if (section.status !== "in_progress") continue;
    section.status = "needs_fix";
    section.last_review = `Run error (will retry): ${message}`;
    changed = true;
  }
  if (changed) await writeJson(paths.sections, sections);
  const diagnostics = await readJson<Record<string, unknown>>(paths.diagnostics, {});
  await writeJson(paths.diagnostics, {
    ...(diagnostics ?? {}),
    updated_at: iso(utcNow()),
    last_error: message,
  });
  await appendJsonl(paths.activity, { event: "run_error", at: iso(utcNow()), error: message, recovered_sections: changed });
  await heartbeatRuntime(paths, { current_section: "", current_step: "", sleep_until: null, ...clearAgentRuntimeFields() });
}

async function buildPrompt(
  paths: ReturnType<typeof statePaths>,
  section: Section,
  node: { id: string; prompt_mode: string },
  priorResults: Record<string, Record<string, unknown>>,
  permissionProfile: ResolvedPermissionProfile,
  injectionProfile: ResolvedInjectionProfile
): Promise<string> {
  const manifestData = await readJson<{ product_doc: string }>(paths.manifest);
  const body = section.body || "(empty)";
  const compiledProgramLine = await pathExists(paths.compiled_program)
    ? `Compiled orchestration program: ${paths.compiled_program}\nRead it before acting. Treat it as the authoritative contract for lifecycle, bridge files, permissions, validators, command hooks, externals, and workspace boundaries.\n`
    : "";
  const compilerReviewLine = await pathExists(paths.compiler_review)
    ? `Compiler review: ${paths.compiler_review}\nRead it before acting. Treat it as the latest structured recommendation layer on top of the compiled program.\n`
    : "";

  const base = `Tracked document: ${manifestData?.product_doc || ""}
Section list: ${paths.sections}
Workspace root: ${paths.workspace}
${compiledProgramLine}
${compilerReviewLine}

Target section:
- id: ${section.id}
- title: ${section.title}
- anchor: ${section.anchor}
- body: ${body}

Permission profile:
- profile: ${permissionProfile.profile_name}
- mode: ${permissionProfile.permission_mode}
- workspace_only: ${permissionProfile.workspace_only ? "true" : "false"}
- restricted_paths: ${permissionProfile.restricted_paths.join(", ") || paths.workspace}
- auto-approved tools: ${permissionProfile.allowed_tools.join(", ") || "(none)"}

${injectionPromptBlock(injectionProfile)}

Stay inside the workspace root. Do not intentionally access files outside ${paths.workspace}. If progress would require a command family outside the current permission profile, stop and report the missing command family as a blocker instead of guessing.
`;

  if (node.prompt_mode === "executor") {
    const reviewNote = section.last_review ? `\n## Previous Review Note:\n${section.last_review}` : "";
    return `${base}${reviewNote}

You are the TNS executor. Make progress on exactly this section. Do not expand scope. Leave workspace in clean state. Output JSON. If skill guidance affected the work, report the skill names in skills_used.`;
  }

  if (node.prompt_mode === "verifier") {
    const executorResult = priorResults["executor"];
    const execSummary = executorResult ? (executorResult.summary as string) || "" : "";
    return `${base}

## Executor Summary:
${execSummary}

You are the TNS verifier. Verify the section with fresh perspective. Your job is to audit whether the delivered artifacts satisfy the original section and whether the executor's summary, files_touched, checks_run, and skills_used are credible. Use injected verifier-stage skills only for independent review, readonly inspection, schema checks, official tests, or evidence collection. Do not repair or re-solve the task. Pass only if actually complete. Output JSON. If skill guidance affected verification, report the skill names in skills_used.`;
  }

  return base;
}

async function buildExplorationPrompt(
  config: TnsConfig,
  paths: ReturnType<typeof statePaths>,
  sections: Section[],
  allowTaskx: boolean,
  taskxFilename: string,
  round: number,
  maxRounds: number,
  permissionProfile: ResolvedPermissionProfile,
  injectionProfile: ResolvedInjectionProfile
): Promise<string> {
  const completed = sections
    .map((section) => `- ${section.title}: ${section.last_summary || "(no summary recorded)"}`)
    .join("\n");

  return `Workspace root: ${paths.workspace}
Primary task document: ${config.product_doc}
Exploration round: ${round}/${maxRounds}

All tracked sections are currently complete. Run a comprehensive review for detail, robustness, consistency, and missing but explicit follow-up requirements.

Completed sections:
${completed || "- none"}

Permission profile:
- profile: ${permissionProfile.profile_name}
- mode: ${permissionProfile.permission_mode}
- workspace_only: ${permissionProfile.workspace_only ? "true" : "false"}
- restricted_paths: ${permissionProfile.restricted_paths.join(", ") || paths.workspace}
- auto-approved tools: ${permissionProfile.allowed_tools.join(", ") || "(none)"}

${injectionPromptBlock(injectionProfile)}

Rules:
- Default to conservative refinement. Only change files when the improvement is concrete and justified.
- Do not reopen vague or speculative work.
- Stay inside the workspace root. Do not intentionally access files outside ${paths.workspace}.
- If you find explicit, concrete new requirements that should become additional tracked work, create ${taskxFilename} in the workspace using markdown sections.
- Only create ${taskxFilename} when the follow-up work is materially useful and clearly actionable.
- If no such follow-up is needed, do not create ${taskxFilename}.

Return JSON only.
`;
}
