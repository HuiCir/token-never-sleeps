import { loadConfig, workflowSettings, attemptsSettings, explorationSettings } from "../lib/config.js";
import { statePaths, ensureInitialized, loadManifest } from "../core/state.js";
import { readJson, writeJson, appendJsonl, pathExists, removePath, resolvePath as resolveFsPath } from "../lib/fs.js";
import { iso, utcNow, sleep } from "../lib/time.js";
import { looksLikeUsageLimitError, looksLikeRetryableError } from "../lib/errors.js";
import { selectSection, updateSection, recoverInProgressSections, ensureSectionDefaults } from "../core/sections.js";
import { runAgent, schemaByName } from "../core/agent.js";
import { firstMatchingTransition, applyTransitionToSection } from "../core/workflow.js";
import { appendHandoff } from "../core/handoff.js";
import { rebuildArtifactIndex } from "../core/artifacts.js";
import type { Section, ExecutorResult, VerifierResult, ReviewRecord, TnsConfig, ExplorationResult, ExplorationState } from "../types.js";
import { withWorkspaceLock } from "../lib/lock.js";
import { beginRuntime, endRuntime, heartbeatRuntime, recoverRuntimeIfInterrupted } from "../core/runtime.js";
import { currentWindow } from "../lib/time.js";
import { loadApprovals, recordApprovalRequest } from "../core/approvals.js";
import { missingApprovalTag, permissionSettings, resolvePermissionProfile, type ResolvedPermissionProfile } from "../lib/permissions.js";
import { relative, resolve as resolvePath } from "node:path";
import { readFile } from "node:fs/promises";

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

function clearAgentRuntimeFields() {
  return {
    current_agent: null,
    agent_pid: null,
    agent_started_at: null,
    agent_deadline_at: null,
  };
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

export async function cmdRun(args: { config: string; once?: boolean; poll_seconds?: number }): Promise<void> {
  const config = loadConfig(args.config);
  await withWorkspaceLock(config.workspace, "tns run", async () => {
    const paths = await ensureInitialized(config, { autoInit: true });
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

  const prompt = await buildExplorationPrompt(config, paths, sections, settings.allow_taskx, settings.taskx_filename, roundsRun + 1, settings.max_rounds_per_window, permissionProfile);
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
    const agentResult = await runAgent(config, paths.workspace, settings.agent, schemaByName("exploration"), prompt, {
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
    await heartbeatRuntime(paths, { current_section: "", current_step: "", sleep_until: null, ...clearAgentRuntimeFields() });
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
    await heartbeatRuntime(paths, { current_section: "", current_step: "", sleep_until: null, ...clearAgentRuntimeFields() });
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

async function runOnce(config: TnsConfig, paths: ReturnType<typeof statePaths>): Promise<RunLoopResult> {
  const freezeState = await normalizeFreeze(paths);
  if (freezeState.blocked) {
    await heartbeatRuntime(paths, { current_section: "", current_step: "", sleep_until: freezeState.nextWakeAt ?? null, ...clearAgentRuntimeFields() });
    return { ran: false, nextWakeAt: freezeState.nextWakeAt ?? null };
  }

  // Recover in-progress sections
  let sections = (await readJson<Section[]>(paths.sections)) || [];
  if (recoverInProgressSections(sections)) {
    await writeJson(paths.sections, sections);
    await appendJsonl(paths.activity, { event: "recover_in_progress", at: iso(utcNow()) });
  }

  sections = sections.map(ensureSectionDefaults);
  const maxAttempts = attemptsSettings(config).max_per_section;
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

      await appendJsonl(paths.activity, {
        event: "agent_start",
        at: iso(utcNow()),
        section: selected.id,
        step: currentStep,
        agent: node.agent,
        permission_profile: permissionProfile.profile_name,
        approval_tag: permissionProfile.approval_tag,
      });
      await heartbeatRuntime(paths, { current_section: selected.id, current_step: currentStep });

      const schema = schemaByName(node.schema || node.id);
      const prompt = await buildPrompt(paths, selected, node, priorResults, permissionProfile);

      let result: { payload: Record<string, unknown>; usage: Record<string, unknown> };
      try {
        const agentResult = await runAgent(config, paths.workspace, node.agent, schema, prompt, {
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
      }

      const { payload, usage } = result;
      const filesTouched = Array.isArray(payload.files_touched)
        ? payload.files_touched.filter((item): item is string => typeof item === "string")
        : [];
      ensureFilesTouchedStayInWorkspace(paths.workspace, filesTouched);
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
  await appendJsonl(paths.activity, { event: "run_error", at: iso(utcNow()), error: message, recovered_sections: changed });
  await heartbeatRuntime(paths, { current_section: "", current_step: "", sleep_until: null, ...clearAgentRuntimeFields() });
}

async function buildPrompt(
  paths: ReturnType<typeof statePaths>,
  section: Section,
  node: { id: string; prompt_mode: string },
  priorResults: Record<string, Record<string, unknown>>,
  permissionProfile: ResolvedPermissionProfile
): Promise<string> {
  const manifestData = await readJson<{ product_doc: string }>(paths.manifest);
  const body = section.body || "(empty)";

  const base = `Tracked document: ${manifestData?.product_doc || ""}
Section list: ${paths.sections}
Workspace root: ${paths.workspace}

Target section:
- id: ${section.id}
- title: ${section.title}
- anchor: ${section.anchor}
- body: ${body}

Permission profile:
- profile: ${permissionProfile.profile_name}
- mode: ${permissionProfile.permission_mode}
- workspace_only: ${permissionProfile.workspace_only ? "true" : "false"}
- auto-approved tools: ${permissionProfile.allowed_tools.join(", ") || "(none)"}

Stay inside the workspace root. Do not intentionally access files outside ${paths.workspace}. If progress would require a command family outside the current permission profile, stop and report the missing command family as a blocker instead of guessing.
`;

  if (node.prompt_mode === "executor") {
    const reviewNote = section.last_review ? `\n## Previous Review Note:\n${section.last_review}` : "";
    return `${base}${reviewNote}

You are the TNS executor. Make progress on exactly this section. Do not expand scope. Leave workspace in clean state. Output JSON.`;
  }

  if (node.prompt_mode === "verifier") {
    const executorResult = priorResults["executor"];
    const execSummary = executorResult ? (executorResult.summary as string) || "" : "";
    return `${base}

## Executor Summary:
${execSummary}

You are the TNS verifier. Verify the section with fresh perspective. Pass only if actually complete. Output JSON.`;
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
  permissionProfile: ResolvedPermissionProfile
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
- auto-approved tools: ${permissionProfile.allowed_tools.join(", ") || "(none)"}

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
