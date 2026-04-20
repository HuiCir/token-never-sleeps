const USAGE_LIMIT_PATTERNS = [
  "usage limit",
  "rate limit",
  "limit reached",
  "too many requests",
  "quota exceeded",
  "overloaded",
  "credit balance is too low",
];

const RETRYABLE_PATTERNS = [
  // Permission errors
  "requires approval",
  "not authorized",
  "edits were not applied",
  "permission denied",
  // Network/transient errors
  "connection",
  "timeout",
  "econnrefused",
  "etimedout",
  "network",
  "temporary failure",
  "name resolution",
  "connection reset",
  "connection refused",
  "broken pipe",
  "host is down",
];

export function looksLikeUsageLimitError(message: string): boolean {
  const text = (message || "").toLowerCase();
  return USAGE_LIMIT_PATTERNS.some((p) => text.includes(p));
}

export function looksLikeRetryableError(message: string): boolean {
  const text = (message || "").toLowerCase();
  return RETRYABLE_PATTERNS.some((p) => text.includes(p));
}

export function makeAgentError(agent: string, proc: { stderr: string; stdout: string }): Error {
  const detail = proc.stderr.trim() || proc.stdout.trim().slice(0, 200) || `${agent} failed`;
  return new Error(`[${agent}] ${detail}`);
}
