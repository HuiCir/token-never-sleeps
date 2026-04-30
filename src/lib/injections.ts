import { mkdir, rm, symlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendJsonl, pathExists } from "./fs.js";
import { injectionSettings } from "./config.js";
import { buildSkillbaseIndex, localSkillExists, matchSkillsFromIndex, resolveSkillFromIndex, skillbaseSelectionSettings, type SkillMatch } from "./skillbase.js";
import { iso, utcNow } from "./time.js";
import type { InjectionProfile, Section, StageInjectionRule, StatePaths, TnsConfig } from "../types.js";

export interface ResolvedInjectionProfile {
  profile_name: string | null;
  mode: "compile" | "executor" | "verifier" | "exploration";
  skills: string[];
  explicit_skills?: string[];
  auto_skills?: string[];
  skill_matches?: SkillMatch[];
  external_skill_paths: string[];
  add_dirs: string[];
  description?: string;
}

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function matchesRule(rule: StageInjectionRule, mode: ResolvedInjectionProfile["mode"], section: Section | null, step: string): boolean {
  const modeOk = !rule.match_mode || rule.match_mode === mode;
  const titleOk = !rule.match_title || (section ? section.title.includes(rule.match_title) : false);
  const stepOk = !rule.match_step || rule.match_step === step;
  return modeOk && titleOk && stepOk;
}

function stateDeclaredSkills(config: TnsConfig, mode: ResolvedInjectionProfile["mode"], section: Section | null): string[] {
  if (!section || (mode !== "executor" && mode !== "verifier")) {
    return [];
  }
  const state = config.program?.states?.find((item) => item.id === section.id);
  if (!state?.parallel) {
    return [];
  }
  return mode === "verifier"
    ? (state.parallel.verifier_skills ?? [])
    : (state.parallel.skills ?? []);
}

function sectionSelectionMode(config: TnsConfig, section: Section | null): "off" | "explicit" | "auto" {
  const configured = skillbaseSelectionSettings(config).mode;
  const text = `${section?.title ?? ""}\n${section?.body ?? ""}`;
  const match = text.match(/^\s*(?:skills|skill-mode)\s*:\s*(off|explicit|auto)\s*$/im);
  return (match?.[1] as "off" | "explicit" | "auto" | undefined) ?? configured;
}

function sectionText(section: Section | null): string {
  return `${section?.title ?? ""}\n${section?.body ?? ""}`;
}

export function resolveInjectionProfile(config: TnsConfig, mode: ResolvedInjectionProfile["mode"], section: Section | null, step: string): ResolvedInjectionProfile {
  const settings = injectionSettings(config);
  const matched = settings.rules?.find((rule) => matchesRule(rule, mode, section, step));
  const profileName = matched?.profile ?? settings.default_profile ?? null;
  const profile = profileName ? (settings.profiles[profileName] ?? {}) : {};
  const declaredSkills = stateDeclaredSkills(config, mode, section);
  const explicitSkills = Array.from(new Set([...(profile.skills ?? []), ...declaredSkills]));
  return {
    profile_name: profileName,
    mode,
    skills: explicitSkills,
    explicit_skills: explicitSkills,
    auto_skills: [],
    skill_matches: [],
    external_skill_paths: Array.from(new Set(profile.external_skill_paths ?? [])),
    add_dirs: Array.from(new Set(profile.add_dirs ?? [])),
    description: profile.description,
  };
}

export async function resolveManagedInjectionProfile(config: TnsConfig, mode: ResolvedInjectionProfile["mode"], section: Section | null, step: string): Promise<ResolvedInjectionProfile> {
  const profile = resolveInjectionProfile(config, mode, section, step);
  if (!section || (mode !== "executor" && mode !== "verifier")) {
    return profile;
  }
  const selection = skillbaseSelectionSettings(config);
  const sectionMode = sectionSelectionMode(config, section);
  const verifierAuto = mode === "verifier" && (selection.verifier_mode === "same" || selection.verifier_mode === "auto");
  const executorAuto = mode === "executor" && sectionMode === "auto";
  if (sectionMode === "off" || (!executorAuto && !verifierAuto)) {
    return profile;
  }
  const index = await buildSkillbaseIndex(config);
  const matches = matchSkillsFromIndex(index, sectionText(section), {
    max: selection.max_matches_per_section,
    minScore: selection.min_score,
  });
  const autoSkills = matches.map((match) => match.name);
  return {
    ...profile,
    skills: Array.from(new Set([...profile.skills, ...autoSkills])),
    auto_skills: autoSkills,
    skill_matches: matches,
  };
}

async function ensureSymlink(linkPath: string, targetPath: string): Promise<void> {
  if (await pathExists(linkPath)) {
    return;
  }
  await symlink(targetPath, linkPath, "dir");
}

function skillRequestName(input: string): string {
  return input.trim().replace(/^import\s+/, "").split(/\s+as\s+/i)[0].trim();
}

function canUseTnsInternalSkill(profile: ResolvedInjectionProfile, skill: string): boolean {
  const name = skillRequestName(skill);
  return profile.mode === "compile" && name.startsWith("tns-");
}

export async function preparePluginSandbox(paths: StatePaths, profile: ResolvedInjectionProfile, runId: string, config?: TnsConfig): Promise<{ plugin_root: string; skills: string[]; external_skill_paths: string[]; add_dirs: string[]; resolved_skills: Record<string, string>; resolved_internal_skills: Record<string, string>; unresolved_skills: string[] }> {
  const sandboxRoot = resolve(paths.agent_runs_dir, `${runId}-plugin`);
  await mkdir(sandboxRoot, { recursive: true });
  await ensureSymlink(resolve(sandboxRoot, ".claude-plugin"), resolve(PLUGIN_ROOT, ".claude-plugin"));
  await ensureSymlink(resolve(sandboxRoot, "agents"), resolve(PLUGIN_ROOT, "agents"));

  const skillsDir = resolve(sandboxRoot, "skills");
  await mkdir(skillsDir, { recursive: true });

  const resolvedSkills: Record<string, string> = {};
  const resolvedInternalSkills: Record<string, string> = {};
  const unresolvedSkills: string[] = [];
  const skillbaseIndex = config ? await buildSkillbaseIndex(config) : null;
  for (const skill of profile.skills) {
    const linkName = skillRequestName(skill);
    const localPath = resolve(PLUGIN_ROOT, "skills", linkName);
    if (canUseTnsInternalSkill(profile, skill) && await localSkillExists(localPath)) {
      await ensureSymlink(resolve(skillsDir, linkName), localPath);
      resolvedInternalSkills[skill] = localPath;
      continue;
    }
    const resolvedSkill = skillbaseIndex ? resolveSkillFromIndex(skillbaseIndex, skill) : null;
    if (resolvedSkill?.found && resolvedSkill.selected) {
      await ensureSymlink(resolve(skillsDir, linkName), resolvedSkill.selected.path);
      resolvedSkills[skill] = resolvedSkill.selected.path;
      continue;
    }
    unresolvedSkills.push(skill);
  }
  for (const skillPath of profile.external_skill_paths) {
    await ensureSymlink(resolve(skillsDir, basename(skillPath)), resolve(skillPath));
    resolvedSkills[skillPath] = resolve(skillPath);
  }

  await appendJsonl(paths.injection_events, {
    event: "plugin_injection",
    at: iso(utcNow()),
    run_id: runId,
    mode: profile.mode,
    profile: profile.profile_name,
    skills: profile.skills,
    explicit_skills: profile.explicit_skills ?? profile.skills,
    auto_skills: profile.auto_skills ?? [],
    skill_matches: (profile.skill_matches ?? []).map((match) => ({
      name: match.name,
      score: match.score,
      path: match.entry.path,
      matched_terms: match.matched_terms,
    })),
    external_skill_paths: profile.external_skill_paths,
    resolved_skills: resolvedSkills,
    resolved_internal_skills: resolvedInternalSkills,
    unresolved_skills: unresolvedSkills,
    add_dirs: profile.add_dirs,
    sandbox_root: sandboxRoot,
  });

  return {
    plugin_root: sandboxRoot,
    skills: profile.skills,
    external_skill_paths: profile.external_skill_paths,
    resolved_skills: resolvedSkills,
    resolved_internal_skills: resolvedInternalSkills,
    unresolved_skills: unresolvedSkills,
    add_dirs: [sandboxRoot, ...profile.add_dirs],
  };
}

export async function gcPluginSandbox(paths: StatePaths, runId: string, sandboxRoot: string): Promise<void> {
  try {
    await rm(sandboxRoot, { recursive: true, force: true });
    await appendJsonl(paths.injection_events, {
      event: "plugin_sandbox_gc",
      at: iso(utcNow()),
      run_id: runId,
      sandbox_root: sandboxRoot,
      removed: true,
    });
  } catch (error: unknown) {
    await appendJsonl(paths.injection_events, {
      event: "plugin_sandbox_gc",
      at: iso(utcNow()),
      run_id: runId,
      sandbox_root: sandboxRoot,
      removed: false,
      error: String(error),
    });
  }
}
