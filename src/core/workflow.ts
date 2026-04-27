import type { Section, Transition, WorkflowNode, ReviewRecord } from "../types.js";
import { iso, utcNow } from "../lib/time.js";

export function payloadValue(payload: Record<string, unknown>, field: string): unknown {
  const parts = field.split(".");
  let current: unknown = payload;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function transitionMatches(payload: Record<string, unknown>, transition: Transition): boolean {
  const field = transition.field;
  if (!field) return true;

  const value = payloadValue(payload, field);
  if (transition.equals !== undefined) return value === transition.equals;
  if (transition.not_equals !== undefined) return value !== transition.not_equals;
  if (transition["in"] !== undefined) return (transition["in"] as unknown[]).includes(value);
  if (transition.truthy === true) return Boolean(value);
  if (transition.truthy === false) return !Boolean(value);
  return false;
}

export function firstMatchingTransition(
  payload: Record<string, unknown>,
  node: WorkflowNode
): Transition {
  for (const transition of node.transitions) {
    if (transitionMatches(payload, transition)) {
      return transition;
    }
  }
  if (node.default_transition) return node.default_transition;
  return {
    set_status: "needs_fix",
    summary_field: "summary",
    review_value: `No workflow transition matched for step ${node.id}. Check workflow config or agent output.`,
    end: true,
  };
}

export function applyTransitionToSection(
  sections: Section[],
  reviews: ReviewRecord[],
  section: Section,
  payload: Record<string, unknown>,
  transition: Transition,
  nodeId: string
): void {
  const now = iso(utcNow());

  if (transition.set_status) {
    section.status = transition.set_status as Section["status"];
  }

  if (transition.summary_field) {
    const val = payloadValue(payload, transition.summary_field);
    if (typeof val === "string") {
      section.last_summary = val;
    }
  }

  if (transition.review_field) {
    const val = payloadValue(payload, transition.review_field);
    if (typeof val === "string") {
      section.last_review = transition.append_review ? `${section.last_review} ${val}`.trim() : val;
    }
  }

  if (transition.review_value !== undefined) {
    section.last_review = transition.append_review
      ? `${section.last_review} ${transition.review_value}`.trim()
      : String(transition.review_value);
  }

  if (transition.set_verified_at) {
    section.verified_at = now;
  }

  section.current_step = transition.next || "";

  if (transition.set_status === "needs_fix") {
    reviews.push({
      section: section.id,
      at: now,
      status: String(payloadValue(payload, "status") || "fail"),
      summary: String(section.last_summary || ""),
      review_note: section.last_review,
      findings: (payloadValue(payload, "findings") as string[]) || [],
      step: nodeId,
    });
  }
}
