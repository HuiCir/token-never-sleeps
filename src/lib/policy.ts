import type { PolicyAction, Section, StatePaths, ValidatorStage } from "../types.js";
import { appendJsonl, writeJson } from "./fs.js";
import { currentWindow, iso, utcNow } from "./time.js";
import { loadManifest } from "../core/state.js";
import type { ResolvedPolicySettings } from "./config.js";

export function policyActionFor(settings: ResolvedPolicySettings, category: "preflight_failure" | "command_failure" | "outside_workspace_violation" | "validator_failure", stage?: ValidatorStage): PolicyAction {
  if (category === "validator_failure") {
    return settings.validator_failure[stage || "post_step"];
  }
  return settings[category];
}

export async function applyPolicyAction(
  paths: StatePaths,
  action: PolicyAction,
  section: Section | null,
  summary: string,
  meta?: Record<string, unknown>
): Promise<"continue" | "stopped" | "failed"> {
  const review = action.review_prefix ? `${action.review_prefix}: ${summary}` : summary;
  if (section) {
    if (action.action === "block_section") {
      section.status = "blocked";
      section.last_review = review;
      section.current_step = "";
    } else if (action.action === "mark_needs_fix") {
      section.status = "needs_fix";
      section.last_review = review;
      section.current_step = "";
    }
  }

  if (action.action === "freeze") {
    const manifest = await loadManifest(paths);
    const freezeSeconds = Math.max(1, Number(action.freeze_seconds ?? 300));
    const until = new Date(Date.now() + freezeSeconds * 1000).toISOString();
    await writeJson(paths.freeze, {
      reason: review,
      at: iso(utcNow()),
      until,
      window: currentWindow(manifest).index,
      ...meta,
    });
    await appendJsonl(paths.activity, {
      event: "policy_freeze",
      at: iso(utcNow()),
      section: section?.id,
      reason: review,
      until,
      ...meta,
    });
    return "stopped";
  }

  if (action.action === "fail_run") {
    await appendJsonl(paths.activity, {
      event: "policy_fail_run",
      at: iso(utcNow()),
      section: section?.id,
      reason: review,
      ...meta,
    });
    return "failed";
  }

  if (action.action === "continue") {
    await appendJsonl(paths.activity, {
      event: "policy_continue",
      at: iso(utcNow()),
      section: section?.id,
      reason: review,
      ...meta,
    });
    return "continue";
  }

  await appendJsonl(paths.activity, {
    event: "policy_apply",
    at: iso(utcNow()),
    section: section?.id,
    action: action.action,
    reason: review,
    ...meta,
  });
  return "stopped";
}
