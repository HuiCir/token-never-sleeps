import { cp, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, loadGlobalConfig } from "../lib/config.js";
import { initState } from "../core/state.js";
import { pathExists, writeJson, writeText } from "../lib/fs.js";
import type { PermissionSettings, TnsConfig, WorkflowSettings } from "../types.js";
import { probeTmux, tmuxPath } from "../lib/platform.js";
import { withResourceLocks } from "../lib/lock.js";
import { statePaths } from "../core/state.js";

type TemplateName = "blank" | "novel-writing";

const DEFAULT_TASK = `# Task

## Section 1
Replace this sample section with one concrete unit of work.

Acceptance criteria:
- Describe the expected files, behavior, or output.
- List the checks TNS should run before marking the section ready.

## Section 2
Replace this sample section with the next concrete unit of work.

Acceptance criteria:
- Keep each section independently reviewable.
- Prefer small sections over one large open-ended task.
`;

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function tmuxAvailable(): boolean {
  return Boolean(tmuxPath());
}

function defaultWorkflow(): WorkflowSettings {
  return {
    entry: "executor",
    max_steps_per_run: 6,
    agents: [
      {
        id: "executor",
        agent: "tns-executor",
        schema: "executor",
        prompt_mode: "executor",
        transitions: [
          { field: "outcome", equals: "blocked", set_status: "blocked", summary_field: "summary", review_field: "blocker", end: true },
          { field: "clean_state", equals: false, set_status: "pending", summary_field: "summary", end: true },
          { field: "ready_for_verification", equals: false, set_status: "pending", summary_field: "summary", end: true },
          { next: "verifier" },
        ],
      },
      {
        id: "verifier",
        agent: "tns-verifier",
        schema: "verifier",
        prompt_mode: "verifier",
        transitions: [
          { field: "status", equals: "pass", set_status: "done", summary_field: "summary", review_value: "", set_verified_at: true, end: true },
          { field: "status", in: ["fail", "blocked"], set_status: "needs_fix", summary_field: "summary", review_field: "review_note", append_review: true, end: true },
        ],
      },
    ],
  };
}

function defaultPermissions(permissionMode: string): PermissionSettings {
  return {
    default_profile: "standard",
    profiles: {
      standard: {
        permission_mode: permissionMode,
        allowed_bash_commands: ["pwd", "ls", "cat", "sed", "rg", "find", "git", "node"],
        workspace_only: true,
      },
    },
    section_profiles: [],
  };
}

async function detectTmuxEnabled(workspace: string, runner: "auto" | "direct" | "tmux"): Promise<boolean> {
  if (runner === "direct") {
    return false;
  }
  const probe = await probeTmux(statePaths({
    workspace,
    product_doc: `${workspace}/task.md`,
    refresh_hours: 5,
    refresh_minutes: null,
    refresh_seconds: null,
    permission_mode: "acceptEdits",
    effort: "high",
    success_interval_seconds: 1,
    idle_interval_seconds: 60,
    max_budget_usd: null,
    tmux: {
      enabled: true,
      auto_create: true,
      session_name: "",
      window_name: "tns",
      socket_name: "",
      manage_runner: true,
      runner_window_name: "tns-runner",
    },
    workflow: defaultWorkflow(),
    attempts: { max_attempts_per_section: 3 },
  }), {
    enabled: true,
    auto_create: true,
    session_name: "",
    window_name: "tns",
    socket_name: "",
    manage_runner: true,
    runner_window_name: "tns-runner",
  });
  if (runner === "tmux" && !probe.available) {
    throw new Error(`tmux runner requested, but tmux is unavailable: ${probe.reason || "unknown reason"}`);
  }
  return probe.available;
}

async function defaultConfig(workspace: string, taskPath: string, runner: "auto" | "direct" | "tmux"): Promise<TnsConfig> {
  const tmuxEnabled = await detectTmuxEnabled(workspace, runner);
  const permissionMode = "acceptEdits";
  return {
    workspace,
    product_doc: taskPath,
    thread: 1,
    refresh_hours: 5,
    refresh_minutes: null,
    refresh_seconds: null,
    permission_mode: permissionMode,
    effort: "high",
    success_interval_seconds: 1,
    idle_interval_seconds: 60,
    max_budget_usd: null,
    permissions: defaultPermissions(permissionMode),
    exploration: {
      enabled: false,
      allow_taskx: true,
      taskx_filename: "taskx.md",
      max_rounds_per_window: 1,
      agent: "tns-executor",
      plan_taskx: true,
      taskx_min_score: 75,
      taskx_branch_dir: ".tns/taskx",
      require_taskx_deliverables: true,
    },
    monitor: {
      heartbeat_seconds: 30,
      max_agent_runtime_seconds: 1800,
      kill_grace_seconds: 15,
    },
    tmux: {
      enabled: tmuxEnabled,
      auto_create: true,
      session_name: "",
      window_name: "tns",
      socket_name: "",
      manage_runner: tmuxEnabled,
      runner_window_name: "tns-runner",
    },
    workflow: defaultWorkflow(),
    attempts: {
      max_attempts_per_section: 3,
    },
    preflight: {
      required_files: ["task.md"],
      required_directories: [".tns"],
    },
    validators: [],
    command_bridge: {
      command_sets: {},
      hooks: [],
    },
    policy: {
      preflight_failure: {
        action: "block_section",
        review_prefix: "Preflight failed",
      },
      command_failure: {
        action: "mark_needs_fix",
        review_prefix: "Command hook failed",
      },
      outside_workspace_violation: {
        action: "block_section",
        review_prefix: "Workspace boundary violation",
      },
      validator_failure: {
        preflight: {
          action: "block_section",
          review_prefix: "Preflight validator failed",
        },
        pre_step: {
          action: "mark_needs_fix",
          review_prefix: "Pre-step validator failed",
        },
        post_step: {
          action: "mark_needs_fix",
          review_prefix: "Post-step validator failed",
        },
        post_run: {
          action: "mark_needs_fix",
          review_prefix: "Post-run validator failed",
        },
      },
    },
    outputs: {
      write_section_outputs: true,
    },
    execution: {
      long_running: {
        agent: "tns-executor",
        workspace: "primary",
        persists_state: true,
        max_parallel: 1,
      },
      temporary: {
        agent: "tns-temp-executor",
        workspace: "temporary",
        persists_state: false,
        must_report_to: "tns-executor",
        gc_after_run: true,
        max_parallel: 1,
      },
      verifier: {
        agent: "tns-verifier",
        workspace: "primary",
        persists_state: false,
        must_report_to: "tns-executor",
        gc_after_run: true,
        max_runtime_seconds: 600,
        max_parallel: 1,
      },
    },
    externals: {
      tools: [],
      skills: [],
      mcp: [],
    },
    skillbases: {
      use_default_sources: true,
      sources: [],
      selection: {
        mode: "explicit",
        max_matches_per_section: 2,
        min_score: 0.22,
        verifier_mode: "none",
      },
    },
    injections: {
      default_profile: null,
      profiles: {
        compiler: {
          skills: ["tns-program-compiler"],
          description: "Inject the compiler skill only for compile synthesis passes.",
        },
        planner: {
          skills: ["tns-task-planner"],
          description: "Inject the planner skill only for task quality and task.md planning passes.",
        },
        executor_task: {
          skills: [],
          external_skill_paths: [],
          description: "Executor-only task skills. Add domain/action skills here; verifier does not inherit them.",
        },
        verifier_audit: {
          skills: [],
          external_skill_paths: [],
          description: "Verifier-only audit skills. Add readonly inspection, schema, test, or Docker verifier skills here.",
        },
      },
      rules: [
        {
          match_mode: "compile",
          profile: "compiler",
        },
        {
          match_mode: "plan",
          profile: "planner",
        },
        {
          match_mode: "executor",
          profile: "executor_task",
        },
        {
          match_mode: "verifier",
          profile: "verifier_audit",
        },
      ],
    },
  };
}

function templateDir(name: TemplateName): string {
  return resolve(PACKAGE_ROOT, "templates", name);
}

async function templateTask(name: TemplateName): Promise<string> {
  if (name === "blank") {
    return DEFAULT_TASK;
  }
  return readFile(resolve(templateDir(name), "task.md"), "utf-8");
}

async function templateConfig(name: TemplateName): Promise<Partial<TnsConfig>> {
  if (name === "blank") {
    return {};
  }
  const raw = await readFile(resolve(templateDir(name), "tns_config.json"), "utf-8");
  return JSON.parse(raw) as Partial<TnsConfig>;
}

async function copyTemplateSupportFiles(name: TemplateName, workspace: string, force: boolean): Promise<void> {
  if (name === "blank") {
    return;
  }
  const source = templateDir(name);
  await cp(source, workspace, {
    recursive: true,
    force,
    errorOnExist: !force,
    filter: (src) => {
      const file = basename(src);
      return file !== "task.md" && file !== "tns_config.json";
    },
  });
}

function mergeConfig(base: TnsConfig, template: Partial<TnsConfig>, workspace: string, taskPath: string, runner: "auto" | "direct" | "tmux"): TnsConfig {
  const merged: TnsConfig = {
    ...base,
    ...template,
    workspace,
    product_doc: taskPath,
    permissions: {
      default_profile: template.permissions?.default_profile ?? base.permissions?.default_profile ?? "standard",
      ...(base.permissions ?? {}),
      ...(template.permissions ?? {}),
      profiles: {
        ...(base.permissions?.profiles ?? {}),
        ...(template.permissions?.profiles ?? {}),
      },
      section_profiles: template.permissions?.section_profiles ?? base.permissions?.section_profiles ?? [],
    },
    exploration: {
      ...(base.exploration ?? {}),
      ...(template.exploration ?? {}),
    },
    tmux: {
      ...base.tmux,
      ...(template.tmux ?? {}),
    },
    monitor: {
      ...(base.monitor ?? {}),
      ...(template.monitor ?? {}),
    },
    workflow: template.workflow && template.workflow.agents?.length ? template.workflow : base.workflow,
    attempts: {
      max_attempts_per_section: template.attempts?.max_attempts_per_section ?? base.attempts?.max_attempts_per_section ?? 3,
    },
    preflight: {
      ...(base.preflight ?? {}),
      ...(template.preflight ?? {}),
    },
    validators: template.validators ?? base.validators ?? [],
    command_bridge: {
      ...(base.command_bridge ?? { command_sets: {}, hooks: [] }),
      ...(template.command_bridge ?? {}),
      command_sets: {
        ...(base.command_bridge?.command_sets ?? {}),
        ...(template.command_bridge?.command_sets ?? {}),
      },
      hooks: template.command_bridge?.hooks ?? base.command_bridge?.hooks ?? [],
    },
    policy: {
      ...(base.policy ?? {}),
      ...(template.policy ?? {}),
      validator_failure: {
        ...(base.policy?.validator_failure ?? {}),
        ...(template.policy?.validator_failure ?? {}),
      },
    },
    outputs: {
      ...(base.outputs ?? {}),
      ...(template.outputs ?? {}),
    },
    externals: {
      ...(base.externals ?? {}),
      ...(template.externals ?? {}),
      tools: template.externals?.tools ?? base.externals?.tools ?? [],
      skills: template.externals?.skills ?? base.externals?.skills ?? [],
      mcp: template.externals?.mcp ?? base.externals?.mcp ?? [],
    },
    program: template.program ?? base.program,
    skillbases: {
      ...(base.skillbases ?? { use_default_sources: true, sources: [] }),
      ...(template.skillbases ?? {}),
      sources: [
        ...(base.skillbases?.sources ?? []),
        ...(template.skillbases?.sources ?? []),
      ],
    },
    injections: {
      ...(base.injections ?? { default_profile: null, profiles: {}, rules: [] }),
      ...(template.injections ?? {}),
      profiles: {
        ...(base.injections?.profiles ?? {}),
        ...(template.injections?.profiles ?? {}),
      },
      rules: template.injections?.rules ?? base.injections?.rules ?? [],
    },
  };

  const tmuxEnabled = runner === "direct" ? false : Boolean(merged.tmux.enabled);
  merged.tmux.enabled = tmuxEnabled;
  merged.tmux.manage_runner = tmuxEnabled && merged.tmux.manage_runner;
  return merged;
}

export async function cmdInit(args: {
  config?: string;
  workspace?: string;
  task?: string;
  template?: TemplateName;
  runner?: "auto" | "direct" | "tmux";
  force?: boolean;
}): Promise<void> {
  if (args.workspace) {
    const workspace = resolve(args.workspace);
    await withResourceLocks(workspace, ["workspace", "config", "state"], "tns init", async () => {
      const taskPath = resolve(args.task || `${workspace}/task.md`);
      const configPath = resolve(args.config || `${workspace}/tns_config.json`);
      const templateName = args.template || "blank";
      const force = Boolean(args.force);

      await mkdir(workspace, { recursive: true });
      await copyTemplateSupportFiles(templateName, workspace, force);

      const created = { task: false, config: false, template: templateName };
      if (force || !(await pathExists(taskPath))) {
        await writeText(taskPath, await templateTask(templateName));
        created.task = true;
      }

      const baseConfig = await defaultConfig(workspace, taskPath, args.runner || "auto");
      const globalConfig = loadGlobalConfig();
      const template = await templateConfig(templateName);
      const mergedConfig = Object.keys(globalConfig).length > 0
        ? {
            ...template,
            workspace,
            product_doc: taskPath,
            tmux: template.tmux ?? baseConfig.tmux,
          }
        : mergeConfig(baseConfig, template, workspace, taskPath, args.runner || "auto");

      if (force || !(await pathExists(configPath))) {
        await writeJson(configPath, mergedConfig);
        created.config = true;
      }

      const config = loadConfig(configPath);
      await initState(config);
      console.log(JSON.stringify({
        initialized: `${workspace}/.tns`,
        workspace,
        config: configPath,
        task: taskPath,
        created,
        runner: config.tmux.enabled && tmuxAvailable() ? "tmux" : "direct",
        tmux_available: tmuxAvailable(),
        next: [
          `cd ${workspace}`,
          "tns plan --text \"describe the task\" --apply --compile",
          "tns status",
          "tns doctor",
          "tns run --once",
          "tns start",
        ],
      }, null, 2));
    });
    return;
  }

  const config = loadConfig(args.config);
  await withResourceLocks(config.workspace, ["workspace", "config", "state"], "tns init", async () => {
    await initState(config);
    console.log(`initialized TNS in ${config.workspace}/.tns`);
  });
}
