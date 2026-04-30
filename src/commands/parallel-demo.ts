import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../lib/config.js";
import { appendJsonl, pathExists, writeJson, writeText } from "../lib/fs.js";
import { withResourceLocks, readWorkspaceLock, pidIsAlive } from "../lib/lock.js";
import { iso, utcNow } from "../lib/time.js";
import { ensureInitialized } from "../core/state.js";
import { preparePluginSandbox, type ResolvedInjectionProfile } from "../lib/injections.js";
import { runAgent, EXECUTOR_SCHEMA } from "../core/agent.js";
import type { AgentOutput, ExecutorResult, StatePaths, TnsConfig } from "../types.js";

type ParallelDemoScenario = "independent" | "collaborative" | "both";

interface DemoArgs {
  config: string;
  scenario?: ParallelDemoScenario;
  agent_timeout_seconds?: number;
  agentTimeoutSeconds?: number;
  keep_sandboxes?: boolean;
  keepSandboxes?: boolean;
}

interface DemoThreadSpec {
  id: string;
  scenario: Exclude<ParallelDemoScenario, "both">;
  title: string;
  outputPath: string;
  prompt: string;
}

interface DemoThreadResult {
  id: string;
  scenario: string;
  ok: boolean;
  output_path: string;
  output_exists: boolean;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  lock_resource: string;
  sandbox_removed: boolean;
  payload?: ExecutorResult;
  usage?: AgentOutput["usage"];
  error?: string;
}

function demoPermissions() {
  return {
    permission_mode: "acceptEdits",
    allowed_tools: [
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "Bash(pwd:*)",
      "Bash(ls:*)",
      "Bash(cat:*)",
      "Bash(test:*)",
      "Bash(mkdir:*)",
      "Bash(git status:*)",
    ],
  };
}

function demoConfig(config: TnsConfig, timeoutSeconds: number): TnsConfig {
  return {
    ...config,
    monitor: {
      ...(config.monitor ?? {}),
      heartbeat_seconds: Math.min(Math.max(1, Number(config.monitor?.heartbeat_seconds ?? 5)), 5),
      max_agent_runtime_seconds: timeoutSeconds,
      kill_grace_seconds: Math.min(Math.max(1, Number(config.monitor?.kill_grace_seconds ?? 5)), 10),
    },
  };
}

function basePrompt(paths: StatePaths, title: string, outputPath: string, body: string): string {
  return `Manual parallel-demo instruction.

Workspace: ${paths.workspace}
Thread title: ${title}

You are one of two Claude threads launched by the TNS parallel demo. This is a functional boundary check, not a production run.

Hard boundaries:
- Work only inside ${paths.workspace}.
- Write exactly this file: ${outputPath}
- Do not edit tns_config.json, task.md, .tns/compiled, or any FSM/program fields.
- Do not edit another thread's output file.
- Keep the content short and deterministic.

Task:
${body}

Before returning, verify the output file exists, then return only JSON matching the supplied schema.`;
}

function independentSpecs(paths: StatePaths): DemoThreadSpec[] {
  return [
    {
      id: "independent-a",
      scenario: "independent",
      title: "independent math note",
      outputPath: "outputs/parallel-demo/independent/math-note.md",
      prompt: basePrompt(paths, "independent math note", "outputs/parallel-demo/independent/math-note.md", [
        "Create a markdown note with:",
        "- heading: # Math Check",
        "- one sentence explaining why 21 + 21 = 42",
        "- one line: owner: independent-a",
      ].join("\n")),
    },
    {
      id: "independent-b",
      scenario: "independent",
      title: "independent text note",
      outputPath: "outputs/parallel-demo/independent/text-note.md",
      prompt: basePrompt(paths, "independent text note", "outputs/parallel-demo/independent/text-note.md", [
        "Create a markdown note with:",
        "- heading: # Text Check",
        "- one sentence describing a concise status report",
        "- one line: owner: independent-b",
      ].join("\n")),
    },
  ];
}

async function writeCollaborativeProblem(paths: StatePaths): Promise<string> {
  const problemPath = "outputs/parallel-demo/collaborative/problem.md";
  await writeText(resolve(paths.workspace, problemPath), [
    "# Shared Problem",
    "",
    "Design a tiny release checklist for a two-file documentation change.",
    "The final checklist should be practical, deterministic, and easy to verify.",
    "",
  ].join("\n"));
  return problemPath;
}

function collaborativeSpecs(paths: StatePaths, problemPath: string): DemoThreadSpec[] {
  return [
    {
      id: "collaborative-a",
      scenario: "collaborative",
      title: "collaborative proposal",
      outputPath: "outputs/parallel-demo/collaborative/proposal.md",
      prompt: basePrompt(paths, "collaborative proposal", "outputs/parallel-demo/collaborative/proposal.md", [
        `Read the shared problem at ${problemPath}.`,
        "Act as thread A. Write a concise proposed release checklist.",
        "Include one line: role: proposal",
      ].join("\n")),
    },
    {
      id: "collaborative-b",
      scenario: "collaborative",
      title: "collaborative review",
      outputPath: "outputs/parallel-demo/collaborative/review.md",
      prompt: basePrompt(paths, "collaborative review", "outputs/parallel-demo/collaborative/review.md", [
        `Read the shared problem at ${problemPath}.`,
        "Act as thread B. Write a concise risk review for the same release checklist problem.",
        "Include one line: role: review",
      ].join("\n")),
    },
  ];
}

async function writeDemoState(paths: StatePaths, runId: string, name: string, payload: unknown): Promise<void> {
  await withResourceLocks(paths.workspace, ["state"], "tns parallel-demo state-write", async () => {
    await writeJson(resolve(paths.state_dir, "parallel-demo", runId, name), payload);
  }, { waitMs: 5000 });
}

async function appendDemoActivity(paths: StatePaths, payload: Record<string, unknown>): Promise<void> {
  await withResourceLocks(paths.workspace, ["state"], "tns parallel-demo activity", async () => {
    await appendJsonl(paths.activity, payload);
  }, { waitMs: 5000 });
}

async function runDemoThread(config: TnsConfig, paths: StatePaths, runId: string, spec: DemoThreadSpec, keepSandbox: boolean): Promise<DemoThreadResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const lockResource = `parallel-demo:${spec.scenario}:${spec.id}`;
  let sandboxRoot: string | null = null;
  let sandboxRemoved = false;

  try {
    const output = await withResourceLocks(paths.workspace, [lockResource], `tns parallel-demo ${spec.id}`, async () => {
      const profile: ResolvedInjectionProfile = {
        profile_name: "parallel-demo",
        mode: "executor",
        skills: [],
        external_skill_paths: [],
        add_dirs: [],
        description: "Manual two-thread demo sandbox",
      };
      const sandbox = await withResourceLocks(paths.workspace, ["state"], "tns parallel-demo injection", async () =>
        preparePluginSandbox(paths, profile, `${runId}-${spec.id}`, config)
      , { waitMs: 5000 });
      sandboxRoot = sandbox.plugin_root;
      return runAgent(config, paths.workspace, "tns-executor", EXECUTOR_SCHEMA, spec.prompt, {
        plugin_dir: sandbox.plugin_root,
        extra_add_dirs: sandbox.add_dirs,
        permissions: demoPermissions(),
      });
    }, { waitMs: 5000 });

    const finishedAt = iso(utcNow());
    const outputExists = await pathExists(resolve(paths.workspace, spec.outputPath));
    const result: DemoThreadResult = {
      id: spec.id,
      scenario: spec.scenario,
      ok: outputExists && (output.payload as ExecutorResult).outcome !== "blocked",
      output_path: spec.outputPath,
      output_exists: outputExists,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: Date.now() - started,
      lock_resource: lockResource,
      sandbox_removed: !keepSandbox,
      payload: output.payload as ExecutorResult,
      usage: output.usage,
    };
    await writeDemoState(paths, runId, `${spec.id}.json`, result);
    await appendDemoActivity(paths, {
      event: "parallel_demo_thread_end",
      at: finishedAt,
      run_id: runId,
      thread: spec.id,
      scenario: spec.scenario,
      ok: result.ok,
      output_path: spec.outputPath,
    });
    return result;
  } catch (error: unknown) {
    const finishedAt = iso(utcNow());
    const result: DemoThreadResult = {
      id: spec.id,
      scenario: spec.scenario,
      ok: false,
      output_path: spec.outputPath,
      output_exists: await pathExists(resolve(paths.workspace, spec.outputPath)),
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: Date.now() - started,
      lock_resource: lockResource,
      sandbox_removed: !keepSandbox,
      error: String(error),
    };
    await writeDemoState(paths, runId, `${spec.id}.json`, result);
    await appendDemoActivity(paths, {
      event: "parallel_demo_thread_error",
      at: finishedAt,
      run_id: runId,
      thread: spec.id,
      scenario: spec.scenario,
      error: result.error,
    });
    return result;
  } finally {
    if (sandboxRoot && !keepSandbox) {
      await rm(sandboxRoot, { recursive: true, force: true });
      sandboxRemoved = true;
    }
    if (sandboxRemoved) {
      await appendDemoActivity(paths, {
        event: "parallel_demo_gc",
        at: iso(utcNow()),
        run_id: runId,
        thread: spec.id,
        removed: sandboxRoot,
      });
    }
  }
}

async function runScenario(config: TnsConfig, paths: StatePaths, runId: string, scenario: Exclude<ParallelDemoScenario, "both">, keepSandbox: boolean): Promise<{ scenario: string; ok: boolean; results: DemoThreadResult[]; merged_output?: string }> {
  const specs = scenario === "independent"
    ? independentSpecs(paths)
    : collaborativeSpecs(paths, await writeCollaborativeProblem(paths));

  await appendDemoActivity(paths, {
    event: "parallel_demo_scenario_start",
    at: iso(utcNow()),
    run_id: runId,
    scenario,
    threads: specs.map((item) => item.id),
  });

  const maxThreads = Math.max(1, Math.min(2, Number(config.threads ?? config.thread ?? 2)));
  const results: DemoThreadResult[] = [];
  if (maxThreads <= 1) {
    for (const spec of specs) {
      results.push(await runDemoThread(config, paths, runId, spec, keepSandbox));
    }
  } else {
    results.push(...await Promise.all(specs.map((spec) => runDemoThread(config, paths, runId, spec, keepSandbox))));
  }
  let mergedOutput: string | undefined;
  if (scenario === "collaborative") {
    mergedOutput = "outputs/parallel-demo/collaborative/combined-summary.md";
    const proposal = results.find((item) => item.id === "collaborative-a");
    const review = results.find((item) => item.id === "collaborative-b");
    await writeText(resolve(paths.workspace, mergedOutput), [
      "# Combined Summary",
      "",
      `proposal_ok: ${Boolean(proposal?.ok)}`,
      `review_ok: ${Boolean(review?.ok)}`,
      "",
      "The two Claude threads worked on the same shared problem with disjoint output files.",
      "The coordinator performed this deterministic merge after both threads completed.",
      "",
    ].join("\n"));
  }
  const ok = results.every((item) => item.ok);
  await appendDemoActivity(paths, {
    event: "parallel_demo_scenario_end",
    at: iso(utcNow()),
    run_id: runId,
    scenario,
    ok,
    merged_output: mergedOutput ?? null,
  });
  return { scenario, ok, results, merged_output: mergedOutput };
}

export async function cmdParallelDemo(args: DemoArgs): Promise<void> {
  const loaded = loadConfig(args.config);
  const timeoutSeconds = Math.max(5, Number(args.agent_timeout_seconds ?? args.agentTimeoutSeconds ?? 120));
  const config = demoConfig(loaded, timeoutSeconds);
  const scenario = args.scenario ?? "both";
  const keepSandbox = Boolean(args.keep_sandboxes ?? args.keepSandboxes ?? false);
  const runId = `parallel-demo-${Date.now()}`;

  await withResourceLocks(config.workspace, ["parallel-demo"], "tns parallel-demo", async () => {
    const existingWorkspaceLock = await readWorkspaceLock(config.workspace);
    if (existingWorkspaceLock && pidIsAlive(existingWorkspaceLock.pid)) {
      throw new Error(`workspace runner is active; refusing parallel demo while workspace lock is held by pid ${existingWorkspaceLock.pid}`);
    }

    const paths = await withResourceLocks(config.workspace, ["state"], "tns parallel-demo setup", async () =>
      ensureInitialized(config, { autoInit: true })
    , { waitMs: 5000 });
    await mkdir(resolve(paths.state_dir, "parallel-demo", runId), { recursive: true });

    const scenarios: Array<Exclude<ParallelDemoScenario, "both">> = scenario === "both"
      ? ["independent", "collaborative"]
      : [scenario];
    const scenarioResults = [];

    for (const item of scenarios) {
      scenarioResults.push(await runScenario(config, paths, runId, item, keepSandbox));
    }

    const summary = {
      ok: scenarioResults.every((item) => item.ok),
      run_id: runId,
      workspace: paths.workspace,
      scenarios: scenarioResults,
      gc: {
        keep_sandboxes: keepSandbox,
        plugin_sandboxes_removed: !keepSandbox,
      },
      execution: {
        configured_threads: Math.max(1, Math.min(2, Number(config.threads ?? config.thread ?? 2))),
        mode: Number(config.threads ?? config.thread ?? 2) > 1 ? "parallel" : "serial",
      },
      boundaries: {
        external_fsm_editing: false,
        runner_workspace_lock_used_for_agent_calls: false,
        per_thread_resource_locks: true,
        state_writes_short_locked: true,
      },
    };
    await writeDemoState(paths, runId, "summary.json", summary);
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) {
      process.exitCode = 1;
    }
  }, { waitMs: 5000 });
}
