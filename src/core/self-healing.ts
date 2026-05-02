import type { Section } from "../types.js";

export type RecoveryCategory = "execution_retry" | "orchestration_recompile" | "logic_blocked";

export interface RecoveryDecision {
  category: RecoveryCategory;
  reason: string;
  signals: string[];
}

const ORCHESTRATION_PATTERNS: Array<[RegExp, string]> = [
  [/\bcompiled program\b/i, "compiled-program"],
  [/\bconfig\.program\b/i, "config-program"],
  [/\bprogram\.json\b/i, "program-json"],
  [/\bparallel_plan\b|\bparallel\.depends_on\b|\bdepends_on\b/i, "parallel-plan"],
  [/\bdependency\b|\bdependencies\b|\bdepends on\b|\bmissing upstream\b|\bupstream\b|\bprerequisite\b/i, "dependency"],
  [/\brequired input\b|\binput file\b|\bbridge file\b|\bartifact\b/i, "input-artifact"],
  [/\bworkflow transition\b|\bNo workflow transition matched\b/i, "workflow-transition"],
  [/\bstate not found\b|\bsection .*not found\b|\bFSM\b|\borchestration\b/i, "fsm-contract"],
  [/\bvalidator\b.*\bmissing\b|\bpreflight\b.*\bmissing\b/i, "compiled-validator"],
];

const RETRYABLE_PATTERNS: Array<[RegExp, string]> = [
  [/\btransient\b|\btemporary\b|\bretry\b/i, "retryable"],
  [/\btimeout\b|\bwatchdog\b|\bdeadline\b/i, "timeout"],
  [/\brate limit\b|\busage limit\b|\b429\b/i, "rate-limit"],
  [/\bECONNRESET\b|\bETIMEDOUT\b|\bEAI_AGAIN\b/i, "network"],
];

function collectSignals(text: string, patterns: Array<[RegExp, string]>): string[] {
  const signals: string[] = [];
  for (const [pattern, signal] of patterns) {
    if (pattern.test(text)) {
      signals.push(signal);
    }
  }
  return Array.from(new Set(signals));
}

export function classifySectionRecovery(section: Section, maxAttempts: number): RecoveryDecision {
  const text = `${section.title}\n${section.last_summary}\n${section.last_review}\n${section.current_step}`;
  const orchestrationSignals = collectSignals(text, ORCHESTRATION_PATTERNS);
  if (orchestrationSignals.length > 0) {
    return {
      category: "orchestration_recompile",
      reason: `Section ${section.id} shows orchestration/configuration signals: ${orchestrationSignals.join(", ")}`,
      signals: orchestrationSignals,
    };
  }

  const retrySignals = collectSignals(text, RETRYABLE_PATTERNS);
  if (section.attempts < maxAttempts) {
    return {
      category: "execution_retry",
      reason: retrySignals.length > 0
        ? `Section ${section.id} has retryable execution signals: ${retrySignals.join(", ")}`
        : `Section ${section.id} has attempts remaining`,
      signals: retrySignals,
    };
  }

  return {
    category: "logic_blocked",
    reason: `Section ${section.id} exhausted ${maxAttempts} attempts without orchestration signals`,
    signals: retrySignals,
  };
}
