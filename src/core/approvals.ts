import { readJson, removePath, writeJson } from "../lib/fs.js";
import { iso, utcNow } from "../lib/time.js";
import type { ApprovalState, StatePaths } from "../types.js";

const EMPTY_APPROVALS: ApprovalState = {
  granted: {},
  pending: {},
};

export async function loadApprovals(paths: StatePaths): Promise<ApprovalState> {
  const approvals = await readJson<ApprovalState>(paths.approvals);
  if (!approvals || typeof approvals !== "object") {
    return { ...EMPTY_APPROVALS };
  }
  return {
    granted: approvals.granted && typeof approvals.granted === "object" ? approvals.granted : {},
    pending: approvals.pending && typeof approvals.pending === "object" ? approvals.pending : {},
  };
}

export async function saveApprovals(paths: StatePaths, approvals: ApprovalState): Promise<void> {
  await writeJson(paths.approvals, approvals);
}

export function isApprovalGranted(approvals: ApprovalState, tag: string | null | undefined): boolean {
  if (!tag) {
    return true;
  }
  return Boolean(approvals.granted[tag]);
}

export async function grantApproval(paths: StatePaths, tag: string, note?: string): Promise<ApprovalState> {
  const approvals = await loadApprovals(paths);
  approvals.granted[tag] = {
    tag,
    granted_at: iso(utcNow()),
    note,
  };
  delete approvals.pending[tag];
  await saveApprovals(paths, approvals);
  return approvals;
}

export async function revokeApproval(paths: StatePaths, tag: string): Promise<ApprovalState> {
  const approvals = await loadApprovals(paths);
  delete approvals.granted[tag];
  await saveApprovals(paths, approvals);
  return approvals;
}

export async function recordApprovalRequest(
  paths: StatePaths,
  request: {
    tag: string;
    section_id: string;
    section_title: string;
    step: string;
    profile: string;
    reason: string;
  }
): Promise<ApprovalState> {
  const approvals = await loadApprovals(paths);
  if (!approvals.pending[request.tag]) {
    approvals.pending[request.tag] = {
      ...request,
      requested_at: iso(utcNow()),
    };
    await saveApprovals(paths, approvals);
  }
  return approvals;
}

export async function clearApprovals(paths: StatePaths): Promise<void> {
  await removePath(paths.approvals);
}
