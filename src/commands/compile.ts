import { readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { commandBridgeSettings, configForWrite, executionSettings, externalSettings, explorationSettings, monitorSettings, outputSettings, policySettings, preflightSettings, programSettings, tmuxSettings, validatorSettings, workflowSettings } from "../lib/config.js";
import { pathExistsSync, readJson, writeJson, writeText } from "../lib/fs.js";
import { parseSections } from "../core/sections.js";
import { ensureInitialized, statePaths } from "../core/state.js";
import { loadConfig } from "../lib/config.js";
import type {
  CommandHookRule,
  CommandSetSpec,
  CompilerPatch,
  CompilerResult,
  ExternalDependencySettings,
  ExternalMcpSpec,
  ExternalSkillSpec,
  ExternalToolSpec,
  FsmStateSpec,
  PermissionSettings,
  PolicySettings,
  PreflightSettings,
  FsmProgramSettings,
  TnsConfig,
  ValidatorSpec,
} from "../types.js";
import { iso, utcNow } from "../lib/time.js";
import { permissionSettings } from "../lib/permissions.js";
import { runAgent, schemaByName } from "../core/agent.js";
import { withResourceLocks } from "../lib/lock.js";
import { gcPluginSandbox, preparePluginSandbox, resolveInjectionProfile } from "../lib/injections.js";
import { buildParallelPlan } from "../core/fsm.js";
import { enrichProgramWithSectionImports, programNeedsSkillMaterialization } from "../lib/skill-planning.js";
import { inferSectionDependencies } from "../core/dependency-graph.js";
import { syncSectionStateFromTask } from "../core/section-state.js";

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter((item) => item.trim().length > 0))).sort();
}

function dedupeByJson<T>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function dedupeByKey<T>(items: T[], keyOf: (item: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(keyOf(item), item);
  }
  return Array.from(map.values());
}

function normalizeExternalSkillSpec(input: unknown): ExternalSkillSpec | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  const name = typeof record.name === "string" && record.name.trim()
    ? record.name
    : typeof record.id === "string" && record.id.trim()
      ? record.id
      : "";
  if (!name) {
    return null;
  }
  return {
    name,
    required: typeof record.required === "boolean" ? record.required : true,
    purpose: typeof record.purpose === "string"
      ? record.purpose
      : Array.isArray(record.notes)
        ? record.notes.map(String).join("; ")
        : typeof record.description === "string"
          ? record.description
          : undefined,
    source_id: typeof record.source_id === "string" ? record.source_id : undefined,
    source_kind: record.source_kind === "skillbase" || record.source_kind === "plugin" || record.source_kind === "skills_dir" ? record.source_kind : undefined,
    source_path: typeof record.source_path === "string" ? record.source_path : undefined,
    path: typeof record.path === "string" ? record.path : undefined,
    content_hash: typeof record.content_hash === "string" ? record.content_hash : undefined,
    installed_at: typeof record.installed_at === "string" ? record.installed_at : undefined,
    registry_package: typeof record.registry_package === "string" ? record.registry_package : undefined,
  };
}

function collectToolUniverse(config: TnsConfig): string[] {
  const perms = permissionSettings(config);
  const fromPermissions = Object.values(perms.profiles)
    .flatMap((profile) => profile.allowed_bash_commands ?? []);
  const fromCommandSets = Object.values(commandBridgeSettings(config).command_sets)
    .flatMap((set: CommandSetSpec) => {
      if (Array.isArray(set.command) && set.command.length > 0) {
        return [set.command[0]];
      }
      return Array.isArray(set.commands) ? set.commands.map((cmd) => cmd.exec).filter(Boolean) : [];
    })
    .filter(Boolean);
  const fromExternals = (externalSettings(config).tools ?? []).map((tool) => tool.name);
  return uniqueSorted([...fromPermissions, ...fromCommandSets, ...fromExternals]);
}

function stripInternalConfig(config: TnsConfig): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  delete clone._config_path;
  delete clone._program_from_compiled;
  return clone;
}

function mergePreflight(base: PreflightSettings | undefined, patch: PreflightSettings | undefined): PreflightSettings {
  return {
    required_files: uniqueSorted([...(base?.required_files ?? []), ...(patch?.required_files ?? [])]),
    required_directories: uniqueSorted([...(base?.required_directories ?? []), ...(patch?.required_directories ?? [])]),
  };
}

function workspacePath(config: TnsConfig, item: string): string {
  return isAbsolute(item) ? item : resolve(config.workspace, item);
}

function filterExistingPreflight(config: TnsConfig, preflight: PreflightSettings): PreflightSettings {
  return {
    required_files: (preflight.required_files ?? []).filter((item) =>
      pathExistsSync(workspacePath(config, item)) ||
      (item === basename(config.product_doc) && pathExistsSync(config.product_doc))
    ),
    required_directories: (preflight.required_directories ?? []).filter((item) =>
      pathExistsSync(workspacePath(config, item))
    ),
  };
}

function mergeValidators(base: ValidatorSpec[] | undefined, patch: ValidatorSpec[] | undefined): ValidatorSpec[] {
  return dedupeByKey([...(base ?? []), ...(patch ?? [])], (item) => item.id);
}

function mergeHooks(base: CommandHookRule[] | undefined, patch: CommandHookRule[] | undefined): CommandHookRule[] {
  return dedupeByJson([...(base ?? []), ...(patch ?? [])]);
}

function mergePermissions(base: PermissionSettings | undefined, patch: PermissionSettings | undefined): PermissionSettings | undefined {
  if (!base && !patch) return undefined;
  const merged: PermissionSettings = {
    default_profile: patch?.default_profile ?? base?.default_profile ?? "standard",
    profiles: {
      ...(base?.profiles ?? {}),
      ...(patch?.profiles ?? {}),
    },
    section_profiles: dedupeByJson([...(base?.section_profiles ?? []), ...(patch?.section_profiles ?? [])]),
  };
  return merged;
}

function mergePolicy(base: PolicySettings | undefined, patch: PolicySettings | undefined): PolicySettings | undefined {
  if (!base && !patch) return undefined;
  return {
    ...(base ?? {}),
    ...(patch ?? {}),
    validator_failure: {
      ...(base?.validator_failure ?? {}),
      ...(patch?.validator_failure ?? {}),
    },
  };
}

function mergeExternals(base: ExternalDependencySettings | undefined, patch: ExternalDependencySettings | undefined): ExternalDependencySettings | undefined {
  if (!base && !patch) return undefined;
  const mergeTools = (items: ExternalToolSpec[] = [], extra: ExternalToolSpec[] = []) =>
    dedupeByKey([...items, ...extra], (item) => item.name);
  const mergeSkills = (items: ExternalSkillSpec[] = [], extra: ExternalSkillSpec[] = []) =>
    dedupeByKey([...items, ...extra], (item) => item.name);
  const mergeMcp = (items: ExternalMcpSpec[] = [], extra: ExternalMcpSpec[] = []) =>
    dedupeByKey([...items, ...extra], (item) => `${item.server}:${item.resource ?? ""}`);
  return {
    tools: mergeTools(base?.tools, patch?.tools),
    skills: mergeSkills(base?.skills, patch?.skills),
    mcp: mergeMcp(base?.mcp, patch?.mcp),
  };
}

function mergeExecution(base: TnsConfig["execution"], patch: TnsConfig["execution"]): TnsConfig["execution"] | undefined {
  if (!base && !patch) return undefined;
  const merged = {
    long_running: {
      ...(base?.long_running ?? {}),
      ...(patch?.long_running ?? {}),
    },
    temporary: {
      ...(base?.temporary ?? {}),
      ...(patch?.temporary ?? {}),
    },
    verifier: {
      ...(base?.verifier ?? {}),
      ...(patch?.verifier ?? {}),
    },
  };
  return executionSettings({ workspace: "", product_doc: "", thread: 1, execution: merged } as TnsConfig);
}

function normalizeCommandSetSpec(id: string, input: unknown): CommandSetSpec | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  const commands = Array.isArray(record.commands)
    ? record.commands
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        .map((item) => ({
          exec: String(item.exec ?? ""),
          args: Array.isArray(item.args) ? item.args.map(String) : [],
          cwd: typeof item.cwd === "string" ? item.cwd : undefined,
          timeout_seconds: typeof item.timeout_seconds === "number" ? item.timeout_seconds : undefined,
          env: item.env && typeof item.env === "object" && !Array.isArray(item.env) ? Object.fromEntries(Object.entries(item.env).map(([k, v]) => [k, String(v)])) : undefined,
          allowed_exit_codes: Array.isArray(item.allowed_exit_codes) ? item.allowed_exit_codes.map((n) => Number(n)) : undefined,
          description: typeof item.description === "string" ? item.description : undefined,
        }))
        .filter((item) => item.exec.length > 0)
    : [];
  const command = Array.isArray(record.command) ? record.command.map(String) : undefined;
  if (!command && commands.length === 0) {
    return null;
  }
  return {
    id,
    description: typeof record.description === "string" ? record.description : undefined,
    command,
    commands,
    cwd: typeof record.cwd === "string" ? record.cwd : undefined,
    timeout_seconds: typeof record.timeout_seconds === "number" ? record.timeout_seconds : undefined,
    env: record.env && typeof record.env === "object" && !Array.isArray(record.env) ? Object.fromEntries(Object.entries(record.env).map(([k, v]) => [k, String(v)])) : undefined,
    allowed_exit_codes: Array.isArray(record.allowed_exit_codes) ? record.allowed_exit_codes.map((n) => Number(n)) : undefined,
  };
}

function looksLikeStage(value: unknown): value is ValidatorSpec["stage"] {
  return value === "preflight" || value === "pre_step" || value === "post_step" || value === "post_run";
}

function normalizeValidatorSpec(input: unknown, commandSets: Record<string, CommandSetSpec>): ValidatorSpec | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id.trim().length > 0 ? record.id : "";
  const stage = looksLikeStage(record.stage) ? record.stage : "post_step";
  const description = typeof record.description === "string" ? record.description : undefined;
  const reviewPrefix =
    record.on_fail && typeof record.on_fail === "object" && !Array.isArray(record.on_fail) && typeof (record.on_fail as Record<string, unknown>).review_prefix === "string"
      ? String((record.on_fail as Record<string, unknown>).review_prefix)
      : undefined;

  const kind = typeof record.kind === "string" ? record.kind : "";
  if (kind === "file_exists" || kind === "directory_exists" || kind === "text_regex" || kind === "text_not_regex" || kind === "json_path_equals" || kind === "command_set") {
    return {
      id,
      stage,
      kind,
      path: typeof record.path === "string" ? record.path : undefined,
      match_title: typeof record.match_title === "string" ? record.match_title : undefined,
      match_step: typeof record.match_step === "string" ? record.match_step : undefined,
      pattern: typeof record.pattern === "string" ? record.pattern : undefined,
      flags: typeof record.flags === "string" ? record.flags : undefined,
      json_path: typeof record.json_path === "string" ? record.json_path : undefined,
      equals: record.equals as string | number | boolean | null | undefined,
      command_set: typeof record.command_set === "string" ? record.command_set : undefined,
      description,
      review_prefix: reviewPrefix,
    };
  }

  const command = record.command;
  if (id && command && typeof command === "object" && !Array.isArray(command)) {
    const cmdRecord = command as Record<string, unknown>;
    if (typeof cmdRecord.exec === "string" && cmdRecord.exec.length > 0) {
      const setId = `validator-${id}`;
      commandSets[setId] = {
        id: setId,
        description: description ?? `Generated from compiler validator ${id}`,
        commands: [{
          exec: cmdRecord.exec,
          args: Array.isArray(cmdRecord.args) ? cmdRecord.args.map(String) : [],
        }],
      };
      return {
        id,
        stage,
        kind: "command_set",
        command_set: setId,
        match_title: typeof record.match_title === "string" ? record.match_title : undefined,
        match_step: typeof record.match_step === "string" ? record.match_step : undefined,
        description,
        review_prefix: reviewPrefix,
      };
    }
  }
  return null;
}

function normalizeCompilerPatch(patch: CompilerPatch | undefined): CompilerPatch {
  const base = defaultCompilerPatch();
  const source = patch ?? {};
  const commandSets: Record<string, CommandSetSpec> = {};
  for (const [id, spec] of Object.entries(source.command_bridge?.command_sets ?? {})) {
    const normalized = normalizeCommandSetSpec(id, spec);
    if (normalized) {
      commandSets[id] = normalized;
    }
  }
  const validators = (source.validators ?? [])
    .map((item) => normalizeValidatorSpec(item, commandSets))
    .filter((item): item is ValidatorSpec => Boolean(item));

  return {
    ...base,
    ...source,
    preflight: mergePreflight(undefined, source.preflight),
    validators,
    command_bridge: {
      command_sets: commandSets,
      hooks: source.command_bridge?.hooks ?? [],
    },
    policy: {
      ...(source.policy ?? {}),
      validator_failure: {
        ...(source.policy?.validator_failure ?? {}),
      },
    },
    permissions: {
      default_profile: source.permissions?.default_profile ?? "standard",
      profiles: source.permissions?.profiles ?? {},
      section_profiles: source.permissions?.section_profiles ?? [],
    },
    externals: {
      tools: source.externals?.tools ?? [],
      skills: (source.externals?.skills ?? [])
        .map((item) => normalizeExternalSkillSpec(item))
        .filter((item): item is ExternalSkillSpec => Boolean(item)),
      mcp: source.externals?.mcp ?? [],
    },
    skillbases: source.skillbases,
    program: source.program && Object.keys(source.program).length > 0 ? source.program : undefined,
  };
}

function mergeCompilerPatch(config: TnsConfig, patch: CompilerPatch): Record<string, unknown> {
  const normalizedPatch = normalizeCompilerPatch(patch);
  const merged = stripInternalConfig(config);
  merged.preflight = filterExistingPreflight(config, mergePreflight(config.preflight, normalizedPatch.preflight));
  merged.validators = mergeValidators(config.validators, normalizedPatch.validators);
  merged.command_bridge = {
    ...(config.command_bridge ?? { command_sets: {}, hooks: [] }),
    ...(normalizedPatch.command_bridge ?? {}),
    command_sets: {
      ...(config.command_bridge?.command_sets ?? {}),
      ...(normalizedPatch.command_bridge?.command_sets ?? {}),
    },
    hooks: mergeHooks(config.command_bridge?.hooks, normalizedPatch.command_bridge?.hooks),
  };
  merged.policy = mergePolicy(config.policy, normalizedPatch.policy);
  merged.permissions = mergePermissions(config.permissions, normalizedPatch.permissions);
  merged.externals = mergeExternals(config.externals, normalizedPatch.externals);
  merged.execution = mergeExecution(config.execution, normalizedPatch.execution);
  merged.skillbases = normalizedPatch.skillbases
    ? {
        ...(config.skillbases ?? {}),
        ...normalizedPatch.skillbases,
        sources: [
          ...(config.skillbases?.sources ?? []),
          ...(normalizedPatch.skillbases.sources ?? []),
        ],
      }
    : config.skillbases;
  const mergedProgram = normalizedPatch.program ?? config.program ?? (programNeedsSkillMaterialization(config) ? buildDerivedSectionProgram(config) : undefined);
  merged.program = mergedProgram ? enrichProgramWithSectionImports(mergedProgram, config) : undefined;
  return merged;
}

function buildDerivedSectionProgram(config: TnsConfig): FsmProgramSettings {
  const sections = parseSections(config.product_doc);
  const dependencyGraph = inferSectionDependencies(sections);
  const states: FsmStateSpec[] = sections.map((section, index) => ({
    id: section.id,
    type: "task" as const,
    description: section.title,
    parallel: {
      depends_on: dependencyGraph.dependencies[section.id] ?? [],
      resource: `section:${section.id}`,
    },
    on_enter: [
      { op: "set" as const, path: "current_section", value: section.id },
      { op: "append" as const, path: "visited_sections", value: section.id },
    ],
    transitions: index < sections.length - 1
      ? [{ id: `next-${section.id}`, to: sections[index + 1].id }]
      : [{ id: `complete-${section.id}`, to: "done" }],
  }));
  states.push({
    id: "done",
    type: "terminal" as const,
    terminal: true,
    description: "All sections visited",
    on_enter: [{ op: "emit" as const, event: "program-complete" }],
    transitions: [],
  });
  return {
    entry: sections[0]?.id ?? "done",
    context: {
      visited_sections: [],
      current_section: sections[0]?.id ?? null,
    },
    states,
    max_steps: Math.max(10, sections.length * 4 || 10),
    threads: Math.max(1, Number(config.threads ?? config.thread ?? 1)),
    parallel: {
      mode: Number(config.threads ?? config.thread ?? 1) > 1 ? "auto" : "off",
      max_threads: Math.max(1, Number(config.threads ?? config.thread ?? 1)),
    },
  };
}

export async function buildCompiledProgram(config: TnsConfig, paths: ReturnType<typeof statePaths>) {
  const sections = parseSections(config.product_doc);
  const taskText = await readFile(config.product_doc, "utf-8");
  const sectionDependencyGraph = inferSectionDependencies(sections);
  const normalizedProgram = enrichProgramWithSectionImports(programSettings(config) ?? buildDerivedSectionProgram(config), config);
  const parallelPlan = buildParallelPlan(normalizedProgram);
  return {
    version: 1,
    compiled_at: iso(utcNow()),
    workspace: {
      root: paths.workspace,
      product_doc: config.product_doc,
      state_dir: paths.state_dir,
      task_digest: {
        filename: basename(config.product_doc),
        section_count: sections.length,
        bytes: Buffer.byteLength(taskText, "utf8"),
      },
    },
    lifecycle: {
      refresh: {
        hours: config.refresh_hours,
        minutes: config.refresh_minutes,
        seconds: config.refresh_seconds,
      },
      monitor: monitorSettings(config),
      tmux: tmuxSettings(config),
      exploration: explorationSettings(config),
      execution: executionSettings(config),
      parallel: {
        configured_threads: Math.max(1, Number(config.threads ?? config.thread ?? normalizedProgram.threads ?? 1)),
        mode: normalizedProgram.parallel?.mode ?? "off",
        max_threads: normalizedProgram.parallel?.max_threads ?? normalizedProgram.threads ?? 1,
      },
    },
    inputs: {
      preflight: preflightSettings(config),
      sections: sections.map((section) => ({
        id: section.id,
        title: section.title,
        anchor: section.anchor,
        body: section.body,
        depends_on: sectionDependencyGraph.dependencies[section.id] ?? [],
        produced_files: sectionDependencyGraph.produced_files[section.id] ?? [],
        referenced_files: sectionDependencyGraph.referenced_files[section.id] ?? [],
      })),
      section_dependency_graph: sectionDependencyGraph,
      program: normalizedProgram,
      parallel_plan: parallelPlan,
    },
    bridge: {
      handoff_file: paths.handoff,
      sections_file: paths.sections,
      reviews_file: paths.reviews,
      activity_file: paths.activity,
      artifacts_file: paths.artifacts,
      approvals_file: paths.approvals,
      runtime_file: paths.runtime,
      diagnostics_file: paths.diagnostics,
      command_runs_file: paths.command_runs,
      section_outputs_dir: paths.section_outputs_dir,
      compiler_review_file: paths.compiler_review,
    },
    orchestration: {
      workflow: workflowSettings(config),
      permissions: permissionSettings(config),
      validators: validatorSettings(config),
      command_bridge: commandBridgeSettings(config),
      policy: policySettings(config),
      outputs: outputSettings(config),
      execution: executionSettings(config),
      program: normalizedProgram,
      parallel_plan: parallelPlan,
    },
    externals: {
      declared: externalSettings(config),
      inferred_tools: collectToolUniverse(config),
      notes: [
        "Declare required skills and MCP servers explicitly in config.externals so the compiler output is complete.",
        "Command sets are runner-side deterministic hooks. Claude should prefer them over ad hoc shell construction.",
      ],
    },
  };
}

function defaultCompilerPatch(): CompilerPatch {
  return {
    preflight: { required_files: [], required_directories: [] },
    validators: [],
    command_bridge: { command_sets: {}, hooks: [] },
    policy: { validator_failure: {} },
    permissions: { default_profile: "standard", profiles: {}, section_profiles: [] },
    externals: { tools: [], skills: [], mcp: [] },
    execution: undefined,
    program: undefined,
  };
}

async function buildCompilerPrompt(paths: ReturnType<typeof statePaths>, config: TnsConfig, compiledProgram: Record<string, unknown>): Promise<string> {
  const taskText = await readFile(config.product_doc, "utf-8");
  const configJson = JSON.stringify(stripInternalConfig(config), null, 2);
  const compiledJson = JSON.stringify(compiledProgram, null, 2);
  return `Workspace root: ${paths.workspace}
Primary task document: ${config.product_doc}
Compiled program path: ${paths.compiled_program}

You are reviewing orchestration quality only. Do not implement the product task itself.

Return a structured patch that improves determinism and runtime quality across:
- preflight
- permissions
- validators
- runner-side command_bridge
- policy
- externals

Constraints:
- Do not edit workspace files during synthesis. Return a patch only.
- Prefer explicit contracts over narrative guidance.
- Prefer command sets for deterministic shell work.
- Do not invent speculative dependencies.
- Keep the patch minimal when the workspace is already explicit enough.
- files_touched should be [] unless TNS is explicitly applying a merged patch later.

Current task.md:
${taskText}

Current config:
${configJson}

Current compiled program:
${compiledJson}

If you have no justified additions for a field, return an empty object or empty array for that field.`;
}

async function synthesizeCompilerReview(config: TnsConfig, paths: ReturnType<typeof statePaths>, compiledProgram: Record<string, unknown>): Promise<CompilerResult> {
  const prompt = await buildCompilerPrompt(paths, config, compiledProgram);
  const injectionProfile = resolveInjectionProfile(config, "compile", null, "compile");
  const runId = `compile-${Date.now()}`;
  const pluginSandbox = await preparePluginSandbox(paths, injectionProfile, runId, config);
  const configPath = config._config_path || `${paths.workspace}/tns_config.json`;
  const originalConfigText = await readFile(configPath, "utf-8");
  let result;
  try {
    result = await runAgent(config, paths.workspace, "tns-compiler", schemaByName("compiler"), prompt, {
      plugin_dir: pluginSandbox.plugin_root,
      extra_add_dirs: pluginSandbox.add_dirs,
      permissions: {
        permission_mode: "default",
        allowed_tools: ["Read", "Glob", "Grep", "LS", "Bash(pwd:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(sed:*)", "Bash(rg:*)", "Bash(find:*)"],
        disallowed_tools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
      },
      paths,
      metadata: {
        run_id: runId,
        agent_mode: "compile",
        step: "compile",
        injection_profile: injectionProfile.profile_name,
        injected_skills: [...pluginSandbox.skills, ...pluginSandbox.external_skill_paths.map((item) => item.split("/").pop() || item)],
      },
    });
  } finally {
    await gcPluginSandbox(paths, runId, pluginSandbox.plugin_root);
  }
  const payload = result.payload as CompilerResult;
  const currentConfigText = await readFile(configPath, "utf-8");
  if (currentConfigText !== originalConfigText) {
    await writeText(configPath, originalConfigText);
    payload.findings = [
      "compiler attempted direct workspace edits during synthesis; TNS reverted those edits and kept only the structured patch",
      ...(payload.findings ?? []),
    ];
    payload.files_touched = [];
  }
  payload.patch = normalizeCompilerPatch(payload.patch);
  return payload;
}

export async function cmdCompile(args: { config?: string; synthesize?: boolean; apply?: boolean }): Promise<void> {
  const initialConfig = loadConfig(args.config);
  await withResourceLocks(initialConfig.workspace, ["workspace", "compile", "config", "state"], "tns compile", async () => {
    const paths = await ensureInitialized(initialConfig, { autoInit: false });

    let activeConfig = initialConfig;
    let compiled = await buildCompiledProgram(activeConfig, paths);
    await writeJson(paths.compiled_program, compiled);
    await syncSectionStateFromTask(activeConfig.product_doc, paths, "compile synchronized task sections");

    let compilerReview: CompilerResult | null = null;
    if (args.synthesize || args.apply) {
      compilerReview = await synthesizeCompilerReview(activeConfig, paths, compiled);
      await writeJson(paths.compiler_review, compilerReview);
    }

    if (args.apply && compilerReview) {
      const mergedConfig = mergeCompilerPatch(activeConfig, compilerReview.patch);
      const configPath = activeConfig._config_path || args.config || "tns_config.json";
      await writeJson(configPath, configForWrite(mergedConfig, configPath));
      activeConfig = loadConfig(configPath);
      compiled = await buildCompiledProgram(activeConfig, paths);
      await writeJson(paths.compiled_program, compiled);
      await syncSectionStateFromTask(activeConfig.product_doc, paths, "compile apply synchronized task sections");
    }

    console.log(JSON.stringify({
      workspace: paths.workspace,
      compiled_program: paths.compiled_program,
      compiler_review: compilerReview ? paths.compiler_review : null,
      section_count: compiled.workspace.task_digest.section_count,
      inferred_tools: compiled.externals.inferred_tools,
      applied: Boolean(args.apply && compilerReview),
      synthesis_confidence: compilerReview?.confidence ?? null,
    }, null, 2));
  });
}
