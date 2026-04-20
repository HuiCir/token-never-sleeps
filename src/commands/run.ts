import { loadConfig, workflowSettings, attemptsSettings } from "../lib/config.js";
import { statePaths, ensureInitialized, loadManifest } from "../core/state.js";
import { readJson, writeJson, appendJsonl } from "../lib/fs.js";
import { iso, utcNow, sleep } from "../lib/time.js";
import { looksLikeUsageLimitError, looksLikeRetryableError } from "../lib/errors.js";
import { selectSection, updateSection, recoverInProgressSections, ensureSectionDefaults } from "../core/sections.js";
import { runAgent, schemaByName } from "../core/agent.js";
import { firstMatchingTransition, applyTransitionToSection } from "../core/workflow.js";
import { appendHandoff } from "../core/handoff.js";
import type { Section, ExecutorResult, VerifierResult, ReviewRecord, TnsConfig } from "../types.js";

export async function cmdRun(args: { config: string; once?: boolean; poll_seconds?: number }): Promise<void> {
  const config = loadConfig(args.config);
  const paths = await ensureInitialized(config);
  const manifest = await loadManifest(paths);

  const successInterval = config.success_interval_seconds || 1;
  const idleInterval = config.idle_interval_seconds || 60;

  while (true) {
    const ran = await runOnce(config, paths);
    if (args.once) break;
    if (!ran) {
      await sleep(idleInterval);
    } else {
      await sleep(successInterval);
    }
  }
}

async function runOnce(config: TnsConfig, paths: ReturnType<typeof statePaths>): Promise<boolean> {
  const { pathExists } = await import("../lib/fs.js");

  // Check freeze
  if (await pathExists(paths.freeze)) {
    return false;
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
    await appendJsonl(paths.activity, { event: "complete", at: iso(utcNow()) });
    return false;
  }

  // Quota check
  await appendJsonl(paths.activity, { event: "quota_check", at: iso(utcNow()), quota: { ok: false, reason: "quota provider disabled" } });

  const wf = workflowSettings(config);
  const nodeMap = new Map(wf.agents.map((n) => [n.id, n]));
  let currentStep = selected.current_step || wf.entry;
  const stepResults: { node_id: string; payload: Record<string, unknown>; usage: unknown }[] = [];
  const priorResults: Record<string, Record<string, unknown>> = {};

  selected.status = "in_progress";
  selected.attempts = (selected.attempts || 0) + 1;
  selected.current_step = currentStep;
  await writeJson(paths.sections, sections);

  try {
    for (let step = 0; step < wf.max_steps_per_run; step++) {
      const node = nodeMap.get(currentStep);
      if (!node) throw new Error(`workflow step not found: ${currentStep}`);

      await appendJsonl(paths.activity, {
        event: "agent_start",
        at: iso(utcNow()),
        section: selected.id,
        step: currentStep,
        agent: node.agent,
      });

      const schema = schemaByName(node.schema || node.id);
      const prompt = await buildPrompt(paths, selected, node, priorResults);

      let result: { payload: Record<string, unknown>; usage: Record<string, unknown> };
      try {
        const agentResult = runAgent(config, paths.workspace, node.agent, schema, prompt);
        result = { payload: agentResult.payload as unknown as Record<string, unknown>, usage: agentResult.usage as unknown as Record<string, unknown> };
      } catch (exc: unknown) {
        const message = String(exc);
        if (looksLikeUsageLimitError(message)) {
          await appendJsonl(paths.activity, { event: "usage_limit_error", at: iso(utcNow()), section: selected.id, error: message });
          sections = (await readJson<Section[]>(paths.sections)) || [];
          updateSection(sections, selected.id, { status: "pending", last_review: "Recovered after usage limit." });
          await writeJson(paths.sections, sections);
          await appendJsonl(paths.activity, { event: "freeze", at: iso(utcNow()), section: selected.id, reason: `usage_limit: ${message}` });
          return false;
        }
        if (looksLikeRetryableError(message)) {
          await appendJsonl(paths.activity, { event: "transient_error", at: iso(utcNow()), section: selected.id, step: currentStep, error: message });
          sections = (await readJson<Section[]>(paths.sections)) || [];
          updateSection(sections, selected.id, { status: "needs_fix", last_review: `Transient error (will retry): ${message.slice(0, 200)}` });
          await writeJson(paths.sections, sections);
          return false;
        }
        throw exc;
      }

      const { payload, usage } = result;
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

      sections = (await readJson<Section[]>(paths.sections)) || [];
      const transition = firstMatchingTransition(payload, node);
      const reviews: ReviewRecord[] = (await readJson<ReviewRecord[]>(paths.reviews)) || [];

      const sectionInList = sections.find((s) => s.id === selected.id);
      if (!sectionInList) throw new Error(`section ${selected.id} not found after transition`);
      ensureSectionDefaults(sectionInList);

      if (transition) {
        applyTransitionToSection(sections, reviews, sectionInList, payload, transition, currentStep);
        await writeJson(paths.reviews, reviews);
        await writeJson(paths.sections, sections);

        const updatedSection = sections.find((s) => s.id === selected.id);
        if (!updatedSection) throw new Error(`section ${selected.id} not found after update`);
        currentStep = updatedSection.current_step || "";

        if (transition.end || !currentStep) break;
      } else {
        break;
      }
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
    return false;
  }

  return true;
}

async function buildPrompt(
  paths: ReturnType<typeof statePaths>,
  section: Section,
  node: { id: string; prompt_mode: string },
  priorResults: Record<string, Record<string, unknown>>
): Promise<string> {
  const manifestData = await readJson<{ product_doc: string }>(paths.manifest);
  const body = section.body || "(empty)";

  const base = `Tracked document: ${manifestData?.product_doc || ""}
Section list: ${paths.sections}

Target section:
- id: ${section.id}
- title: ${section.title}
- anchor: ${section.anchor}
- body: ${body}
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
