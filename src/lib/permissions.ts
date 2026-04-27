import type { ApprovalState, PermissionProfile, PermissionSettings, Section, TnsConfig } from "../types.js";

export interface ResolvedPermissionProfile {
  profile_name: string;
  permission_mode: string;
  allowed_tools: string[];
  disallowed_tools: string[];
  approval_tag: string | null;
  workspace_only: boolean;
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
        workspace_only: true,
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

export function resolvePermissionProfile(config: TnsConfig, section: Section, step: string): ResolvedPermissionProfile {
  const settings = permissionSettings(config);
  const matched = settings.section_profiles?.find((rule) => matchesRule(rule, section, step));
  const profileName = matched?.profile || settings.default_profile;
  const profile = settings.profiles[profileName] || settings.profiles[settings.default_profile] || {};
  const tools = normalizeTools(profile);
  return {
    profile_name: profileName,
    permission_mode: profile.permission_mode ?? config.permission_mode ?? "acceptEdits",
    allowed_tools: tools.allowed_tools,
    disallowed_tools: tools.disallowed_tools,
    approval_tag: profile.requires_approval ?? null,
    workspace_only: profile.workspace_only ?? true,
  };
}

export function missingApprovalTag(approvals: ApprovalState, profile: ResolvedPermissionProfile): string | null {
  if (!profile.approval_tag) {
    return null;
  }
  return approvals.granted[profile.approval_tag] ? null : profile.approval_tag;
}
