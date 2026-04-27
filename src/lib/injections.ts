import { mkdir, symlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendJsonl, pathExists } from "./fs.js";
import { injectionSettings } from "./config.js";
import { iso, utcNow } from "./time.js";
import type { InjectionProfile, Section, StageInjectionRule, StatePaths, TnsConfig } from "../types.js";

export interface ResolvedInjectionProfile {
  profile_name: string | null;
  mode: "compile" | "executor" | "verifier" | "exploration";
  skills: string[];
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

export function resolveInjectionProfile(config: TnsConfig, mode: ResolvedInjectionProfile["mode"], section: Section | null, step: string): ResolvedInjectionProfile {
  const settings = injectionSettings(config);
  const matched = settings.rules?.find((rule) => matchesRule(rule, mode, section, step));
  const profileName = matched?.profile ?? settings.default_profile ?? null;
  const profile = profileName ? (settings.profiles[profileName] ?? {}) : {};
  return {
    profile_name: profileName,
    mode,
    skills: Array.from(new Set(profile.skills ?? [])),
    external_skill_paths: Array.from(new Set(profile.external_skill_paths ?? [])),
    add_dirs: Array.from(new Set(profile.add_dirs ?? [])),
    description: profile.description,
  };
}

async function ensureSymlink(linkPath: string, targetPath: string): Promise<void> {
  if (await pathExists(linkPath)) {
    return;
  }
  await symlink(targetPath, linkPath, "dir");
}

export async function preparePluginSandbox(paths: StatePaths, profile: ResolvedInjectionProfile, runId: string): Promise<{ plugin_root: string; skills: string[]; external_skill_paths: string[]; add_dirs: string[] }> {
  const sandboxRoot = resolve(paths.agent_runs_dir, `${runId}-plugin`);
  await mkdir(sandboxRoot, { recursive: true });
  await ensureSymlink(resolve(sandboxRoot, ".claude-plugin"), resolve(PLUGIN_ROOT, ".claude-plugin"));
  await ensureSymlink(resolve(sandboxRoot, "agents"), resolve(PLUGIN_ROOT, "agents"));

  const skillsDir = resolve(sandboxRoot, "skills");
  await mkdir(skillsDir, { recursive: true });

  for (const skill of profile.skills) {
    await ensureSymlink(resolve(skillsDir, skill), resolve(PLUGIN_ROOT, "skills", skill));
  }
  for (const skillPath of profile.external_skill_paths) {
    await ensureSymlink(resolve(skillsDir, basename(skillPath)), resolve(skillPath));
  }

  await appendJsonl(paths.injection_events, {
    event: "plugin_injection",
    at: iso(utcNow()),
    run_id: runId,
    mode: profile.mode,
    profile: profile.profile_name,
    skills: profile.skills,
      external_skill_paths: profile.external_skill_paths,
      add_dirs: profile.add_dirs,
      sandbox_root: sandboxRoot,
    });

  return {
    plugin_root: sandboxRoot,
    skills: profile.skills,
    external_skill_paths: profile.external_skill_paths,
    add_dirs: [sandboxRoot, ...profile.add_dirs],
  };
}
