import type { ApprovalState, PermissionProfile, PermissionSettings, Section, TnsConfig } from "../types.js";
import { isAbsolute, relative, resolve } from "node:path";
import { expandUser } from "./fs.js";

export type ResolvedPathScope = "workspace" | "global" | "workspace_whitelist";

export interface ResolvedPermissionProfile {
  profile_name: string;
  permission_mode: string;
  allowed_tools: string[];
  disallowed_tools: string[];
  approval_tag: string | null;
  workspace_only: boolean;
  path_scope: ResolvedPathScope;
  allowed_paths: string[];
  access_roots: string[];
  restricted_paths: string[];
}

const DEFAULT_STANDARD_COMMANDS = [
  "pwd",
  "ls",
  "cat",
  "sed",
  "rg",
  "find",
  "git",
  "node",
];

function defaultPermissionSettings(config: TnsConfig): PermissionSettings {
  return {
    default_profile: "standard",
    profiles: {
      standard: {
        permission_mode: config.permission_mode ?? "acceptEdits",
        allowed_bash_commands: DEFAULT_STANDARD_COMMANDS,
        path_scope: "workspace",
      },
    },
    section_profiles: [],
  };
}

export function permissionSettings(config: TnsConfig): PermissionSettings {
  const base = defaultPermissionSettings(config);
  const cfg = config.permissions;
  if (!cfg || typeof cfg !== "object") {
    return base;
  }
  return {
    default_profile: cfg.default_profile || base.default_profile,
    profiles: {
      ...base.profiles,
      ...(cfg.profiles ?? {}),
    },
    section_profiles: cfg.section_profiles ?? [],
  };
}

function matchesRule(rule: { match_title?: string; match_step?: string }, section: Section, step: string): boolean {
  const titleOk = !rule.match_title || section.title.includes(rule.match_title);
  const stepOk = !rule.match_step || step === rule.match_step;
  return titleOk && stepOk;
}

function bashPattern(prefix: string): string {
  if (prefix.startsWith("Bash(")) {
    return prefix;
  }
  return `Bash(${prefix}:*)`;
}

function normalizeTools(profile: PermissionProfile): { allowed_tools: string[]; disallowed_tools: string[] } {
  const allowed = [
    ...(profile.allowed_tools ?? []),
    ...(profile.allowed_bash_commands ?? []).map(bashPattern),
  ];
  const disallowed = [
    ...(profile.disallowed_tools ?? []),
    ...(profile.disallowed_bash_commands ?? []).map(bashPattern),
  ];
  return {
    allowed_tools: Array.from(new Set(allowed)),
    disallowed_tools: Array.from(new Set(disallowed)),
  };
}

function resolveConfiguredPath(workspace: string, item: string): string {
  const expanded = expandUser(item);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(workspace, expanded);
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}

function normalizePathScope(profile: PermissionProfile): ResolvedPathScope {
  const raw = profile.path_scope;
  if (raw === "global" || raw === "globe") {
    return "global";
  }
  if (raw === "workspace_whitelist" || raw === "workspace+whitelist") {
    return "workspace_whitelist";
  }
  const whitelist = [
    ...(profile.allowed_paths ?? []),
    ...(profile.whitelist_paths ?? []),
  ];
  if (whitelist.length > 0) {
    return "workspace_whitelist";
  }
  if (profile.workspace_only === false) {
    return "global";
  }
  return "workspace";
}

function configuredWhitelist(profile: PermissionProfile): string[] {
  return unique([
    ...(profile.allowed_paths ?? []),
    ...(profile.whitelist_paths ?? []),
  ].map(String));
}

function pathIsWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolvePermissionProfile(config: TnsConfig, section: Section, step: string): ResolvedPermissionProfile {
  const settings = permissionSettings(config);
  const matched = settings.section_profiles?.find((rule) => matchesRule(rule, section, step));
  const profileName = matched?.profile || settings.default_profile;
  const profile = settings.profiles[profileName] || settings.profiles[settings.default_profile] || {};
  const tools = normalizeTools(profile);
  const pathScope = normalizePathScope(profile);
  const workspace = resolve(config.workspace);
  const allowedPaths = configuredWhitelist(profile).map((item) => resolveConfiguredPath(workspace, item));
  const accessRoots = pathScope === "global"
    ? ["/"]
    : pathScope === "workspace_whitelist"
      ? unique([workspace, ...allowedPaths])
      : [workspace];
  return {
    profile_name: profileName,
    permission_mode: profile.permission_mode ?? config.permission_mode ?? "acceptEdits",
    allowed_tools: tools.allowed_tools,
    disallowed_tools: tools.disallowed_tools,
    approval_tag: profile.requires_approval ?? null,
    workspace_only: pathScope === "workspace",
    path_scope: pathScope,
    allowed_paths: allowedPaths,
    access_roots: accessRoots,
    restricted_paths: Array.isArray(profile.restricted_paths) ? profile.restricted_paths.map(String) : [],
  };
}

export function assertFilesTouchedAllowed(workspace: string, filesTouched: string[], profile: ResolvedPermissionProfile): void {
  const root = resolve(workspace);
  const protectedState = resolve(root, ".tns");
  for (const file of filesTouched) {
    const resolved = resolve(root, expandUser(file));
    if (pathIsWithin(protectedState, resolved)) {
      throw new Error(`files_touched contains protected TNS state path: ${file}`);
    }
    if (profile.path_scope === "global") {
      continue;
    }
    const allowed = profile.access_roots.some((accessRoot) => pathIsWithin(accessRoot, resolved));
    if (!allowed) {
      throw new Error(`files_touched contains path outside ${profile.path_scope} permission scope: ${file}`);
    }
  }
}

export function missingApprovalTag(approvals: ApprovalState, profile: ResolvedPermissionProfile): string | null {
  if (!profile.approval_tag) {
    return null;
  }
  return approvals.granted[profile.approval_tag] ? null : profile.approval_tag;
}
