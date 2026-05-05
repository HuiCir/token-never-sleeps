import { readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { runAgent, schemaByName } from "../core/agent.js";
import { syncSectionStateFromTask } from "../core/section-state.js";
import { ensureInitialized, statePaths } from "../core/state.js";
import { buildCompiledProgram } from "./compile.js";
import { appendJsonl, pathExists, writeJson, writeText } from "../lib/fs.js";
import { loadConfig } from "../lib/config.js";
import { withResourceLocks } from "../lib/lock.js";
import { iso, utcNow } from "../lib/time.js";
import { gcPluginSandbox, preparePluginSandbox, resolveInjectionProfile } from "../lib/injections.js";
import type { AgentUsage, TaskPlanResult, TnsConfig } from "../types.js";

export interface TaskQualityReport {
  score: number;
  threshold: number;
  grade: "good" | "needs_polish" | "poor";
  should_polish: boolean;
  section_count: number;
  issues: string[];
  strengths: string[];
}

function resolveWorkspacePath(workspace: string, input: string): string {
  return isAbsolute(input) ? input : resolve(workspace, input);
}

function countTaskSections(markdown: string): number {
  return markdown.split(/\r?\n/).filter((line) => /^##\s+\S/.test(line)).length;
}

const REQUIRED_SECTION_LABELS = ["Objective", "Inputs", "Deliverables", "Acceptance criteria", "Verification"];

function labelPattern(label: string): RegExp {
  return new RegExp(`^\\s*(?:\\*\\*)?${label.replace(/\s+/g, "\\s+")}(?:\\*\\*)?\\s*:`, "im");
}

function sectionComplianceErrors(markdown: string): string[] {
  const errors: string[] = [];
  if (/^###\s+\S/m.test(markdown)) {
    errors.push("do not use ### headings; TNS treats ## and ### headings as tracked sections");
  }
  if (/^import\s+skill\s*:/im.test(markdown)) {
    errors.push("skill imports must use 'import <skill-name>' syntax, not 'import skill:'");
  }
  const sections = markdown.split(/^##\s+/m).slice(1);
  if (sections.length === 0) {
    return ["planned_task_markdown must contain at least one ## section"];
  }
  sections.forEach((rawSection, index) => {
    const [titleLine = "", ...bodyLines] = rawSection.split(/\r?\n/);
    const title = titleLine.trim() || `section ${index + 1}`;
    const body = bodyLines.join("\n");
    for (const label of REQUIRED_SECTION_LABELS) {
      if (!labelPattern(label).test(body)) {
        errors.push(`${title}: missing '${label}:' label`);
      }
    }
  });
  return errors;
}

function splitTaskSections(markdown: string): Array<{ title: string; body: string }> {
  return markdown.split(/^##\s+/m).slice(1).map((rawSection, index) => {
    const [titleLine = "", ...bodyLines] = rawSection.split(/\r?\n/);
    return {
      title: titleLine.trim() || `section ${index + 1}`,
      body: bodyLines.join("\n"),
    };
  });
}

function concreteArtifacts(markdown: string): string[] {
  const artifacts = new Set<string>();
  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    const candidate = match[1].trim();
    if (/\.(?:json|md|txt|csv|ts|tsx|js|jsx|py|sh|ya?ml|toml|html|css|xml|sql)$/i.test(candidate)) {
      artifacts.add(candidate);
    }
  }
  return Array.from(artifacts);
}

function concreteArtifactCount(markdown: string): number {
  return concreteArtifacts(markdown).length;
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function evaluateTaskQuality(markdown: string, threshold: number): TaskQualityReport {
  const issues: string[] = [];
  const strengths: string[] = [];
  let score = 100;
  const trimmed = markdown.trim();
  const sections = splitTaskSections(markdown);
  const sectionCount = sections.length;

  if (!trimmed) {
    return {
      score: 0,
      threshold,
      grade: "poor",
      should_polish: true,
      section_count: 0,
      issues: ["task document is empty"],
      strengths: [],
    };
  }

  if (!/^#\s+\S/m.test(markdown)) {
    score -= 8;
    issues.push("missing top-level markdown heading");
  } else {
    strengths.push("has a top-level task heading");
  }

  if (sectionCount === 0) {
    score -= 45;
    issues.push("missing ## sections, so TNS can only track one broad unit of work");
  } else if (sectionCount === 1 && trimmed.length > 1200) {
    score -= 18;
    issues.push("single long section should be split into smaller reviewable sections");
  } else {
    strengths.push(`has ${sectionCount} tracked section${sectionCount === 1 ? "" : "s"}`);
  }

  const artifactCount = concreteArtifactCount(markdown);
  if (artifactCount >= 2 && sectionCount < 2) {
    score -= 28;
    issues.push("multiple concrete artifacts are bundled into one section; split independent deliverables so TNS can schedule them concurrently");
  }
  const bundledSections = sections
    .map((section) => ({ title: section.title, artifacts: concreteArtifacts(section.body).length }))
    .filter((section) => section.artifacts >= 2);
  if (bundledSections.length > 0) {
    score -= Math.min(30, bundledSections.length * 12);
    issues.push(...bundledSections.slice(0, 5).map((section) => `${section.title}: bundles ${section.artifacts} concrete artifacts into one section; split independent deliverables when they can run separately`));
  }

  const complianceErrors = sectionCount > 0 ? sectionComplianceErrors(markdown) : [];
  if (complianceErrors.length > 0) {
    const missingPenalty = Math.min(35, complianceErrors.length * 4);
    score -= missingPenalty;
    issues.push(...complianceErrors.slice(0, 10));
  } else if (sectionCount > 0) {
    strengths.push("all sections contain the required planning labels");
  }

  if (!/Acceptance criteria\s*:/i.test(markdown) && !/验收|接受标准|完成标准/.test(markdown)) {
    score -= 14;
    issues.push("missing explicit acceptance criteria");
  }
  if (!/Verification\s*:/i.test(markdown) && !/验证|检查|测试/.test(markdown)) {
    score -= 14;
    issues.push("missing explicit verification instructions");
  }
  if (!/`[^`\n]+`/.test(markdown)) {
    score -= 10;
    issues.push("no concrete backticked file paths or artifacts for dependency inference");
  } else {
    strengths.push("mentions concrete files or artifacts");
  }
  if (!/(Depends on|依赖|取决于)\s*[:：]/i.test(markdown) && sectionCount > 1) {
    score -= 5;
    issues.push("multi-section task has no explicit dependency lines");
  }
  if (/(随便|大概|等等|完善一下|优化一下|处理一下|修复问题|make it better|improve things|etc\.)/i.test(markdown)) {
    score -= 12;
    issues.push("contains vague action language that should be converted into concrete deliverables");
  }
  for (const section of sections) {
    if (section.body.length > 2200) {
      score -= 8;
      issues.push(`${section.title}: body is very long and may be hard to execute in one run`);
    }
    if (!/(- |\d+\. )/.test(section.body)) {
      score -= 4;
      issues.push(`${section.title}: lacks bullet/numbered task details`);
    }
  }

  const finalScore = clampScore(score);
  const grade: TaskQualityReport["grade"] = finalScore >= threshold ? "good" : finalScore >= Math.max(40, threshold - 20) ? "needs_polish" : "poor";
  return {
    score: finalScore,
    threshold,
    grade,
    should_polish: finalScore < threshold,
    section_count: sectionCount,
    issues: Array.from(new Set(issues)),
    strengths: Array.from(new Set(strengths)),
  };
}

function stripOuterFence(markdown: string): string {
  const trimmed = markdown.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  return match ? match[1].trim() : trimmed;
}

function normalizePlannedTask(markdown: string): string {
  let task = stripOuterFence(markdown);
  if (!/^#\s+\S/m.test(task)) {
    task = `# Task\n\n${task}`;
  }
  if (!/^#\s+Task\s*$/m.test(task)) {
    task = task.replace(/^#\s+.+$/m, "# Task");
  }
  if (countTaskSections(task) === 0) {
    throw new Error("planner returned task.md without any ## sections");
  }
  const complianceErrors = sectionComplianceErrors(task);
  if (complianceErrors.length > 0) {
    throw new Error(`planner returned non-compliant task.md: ${complianceErrors.slice(0, 8).join("; ")}`);
  }
  return `${task.trim()}\n`;
}

async function readPlanSource(config: TnsConfig, args: { text?: string; input?: string }): Promise<{ label: string; text: string }> {
  if (args.text && args.text.trim()) {
    return { label: "inline --text", text: args.text.trim() };
  }
  if (args.input && args.input.trim()) {
    const inputPath = resolveWorkspacePath(config.workspace, args.input);
    return { label: inputPath, text: await readFile(inputPath, "utf-8") };
  }
  return { label: config.product_doc, text: await readFile(config.product_doc, "utf-8") };
}

function buildTaskPlanningPrompt(config: TnsConfig, sourceLabel: string, sourceText: string, retryFeedback = ""): string {
  const retryBlock = retryFeedback
    ? `\nPrevious planner output was rejected for these structural problems:\n${retryFeedback}\n\nReturn a fully revised complete JSON result. Do not patch or describe the previous result.\n`
    : "";
  return `Workspace root: ${config.workspace}
Primary task document: ${config.product_doc}
Planning source: ${sourceLabel}
${retryBlock}

Convert the following natural-language request or rough task draft into a concrete TNS task.md.

Use only the Source block below as the planning input. Do not inspect or rely on existing .tns state, compiled programs, sections.json, prior task-plan reviews, or unrelated workspace files unless they are explicitly named in the Source block.

Planning goals:
- Make the task executable by a long-running section runner.
- Keep sections small, ordered, independently reviewable, and artifact-oriented.
- Preserve explicit user constraints and avoid invented scope.
- Use workspace-relative file paths in backticks when the source names or clearly implies files.
- Do not copy the workspace root path from this prompt into task.md. Use relative paths unless the Source explicitly names an absolute path.
- Include dependency lines with "Depends on:" where ordering matters.
- When the source lists multiple independent deliverables, split them into separate ## sections so TNS can schedule them with multiple threads.
- Do not emit executable skill imports. Never write "import <skill>" or "import skill:" in planned_task_markdown.
- If a skill may help, write "Recommended skills: <skill-name>" as non-binding guidance only.
- Put acceptance criteria and verification instructions into every section.
- Every ## section must contain these exact plain labels, each followed by a colon:
  Objective:
  Inputs:
  Deliverables:
  Acceptance criteria:
  Verification:
- Use only ## headings for tracked sections. Do not use ### headings or separate phase headings.

Do not implement the task. Do not edit files. Return JSON only.

Source:
${sourceText}`;
}

export async function polishTaskText(
  config: TnsConfig,
  paths: ReturnType<typeof statePaths>,
  sourceLabel: string,
  sourceText: string
): Promise<{ payload: TaskPlanResult; usage: AgentUsage; runId: string }> {
  let retryFeedback = "";
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = buildTaskPlanningPrompt(config, sourceLabel, sourceText, retryFeedback);
    const runId = `plan-${Date.now()}-${attempt}`;
    const configuredProfile = resolveInjectionProfile(config, "plan", null, "plan");
    const injectionProfile = configuredProfile.skills.length > 0 || configuredProfile.external_skill_paths.length > 0
      ? configuredProfile
      : {
          ...configuredProfile,
          profile_name: configuredProfile.profile_name ?? "planner",
          skills: ["tns-task-planner"],
          explicit_skills: ["tns-task-planner"],
          description: configuredProfile.description ?? "Default internal task planner skill.",
        };
    const pluginSandbox = await preparePluginSandbox(paths, injectionProfile, runId, config);
    let agentResult;
    try {
      agentResult = await runAgent({ ...config, effort: "medium" }, paths.workspace, "tns-task-planner", schemaByName("task-planner"), prompt, {
        plugin_dir: pluginSandbox.plugin_root,
        extra_add_dirs: pluginSandbox.add_dirs,
        permissions: {
          permission_mode: "default",
          disallowed_tools: ["Read", "Glob", "Grep", "LS", "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"],
        },
        claude: {
          bare: true,
          strict_mcp_config: true,
          mcp_config: "{\"mcpServers\":{}}",
          no_session_persistence: true,
        },
        timeout_ms: 3 * 60 * 1000,
        paths,
        metadata: {
          run_id: runId,
          agent_mode: "plan",
          step: "plan",
          injection_profile: injectionProfile.profile_name,
          injected_skills: [...pluginSandbox.skills, ...pluginSandbox.external_skill_paths.map((item) => item.split("/").pop() || item)],
        },
      });
    } catch (exc) {
      lastError = exc instanceof Error ? exc : new Error(String(exc));
      retryFeedback = `planner agent call failed or returned invalid schema: ${lastError.message}`;
      await gcPluginSandbox(paths, runId, pluginSandbox.plugin_root);
      continue;
    } finally {
      if (agentResult) {
        await gcPluginSandbox(paths, runId, pluginSandbox.plugin_root);
      }
    }
    const payload = agentResult.payload as TaskPlanResult;
    try {
      payload.planned_task_markdown = normalizePlannedTask(payload.planned_task_markdown);
      if (/^import\s+\S+/im.test(payload.planned_task_markdown)) {
        throw new Error("planner emitted executable import lines; use 'Recommended skills:' for non-binding guidance");
      }
      if (!sourceText.includes(paths.workspace) && payload.planned_task_markdown.includes(paths.workspace)) {
        throw new Error("planner copied the workspace absolute path into task.md; use relative paths instead");
      }
      payload.section_count = countTaskSections(payload.planned_task_markdown);
      return { payload, usage: agentResult.usage, runId };
    } catch (exc) {
      lastError = exc instanceof Error ? exc : new Error(String(exc));
      retryFeedback = lastError.message;
    }
  }
  throw lastError ?? new Error("task planner failed");
}

export async function cmdPlan(args: {
  config?: string;
  text?: string;
  input?: string;
  output?: string;
  apply?: boolean;
  compile?: boolean;
  check?: boolean;
  polish?: boolean;
  min_score?: number;
  minScore?: number;
}): Promise<void> {
  const initialConfig = loadConfig(args.config);
  if (args.compile && !args.apply) {
    throw new Error("tns plan --compile requires --apply so the compiled program matches task.md");
  }
  await withResourceLocks(initialConfig.workspace, ["workspace", "state", "compile"], "tns plan", async () => {
    const paths = await ensureInitialized(initialConfig);
    const { label, text } = await readPlanSource(initialConfig, args);
    const threshold = Math.max(1, Math.min(100, Number(args.min_score ?? args.minScore ?? 75)));
    const quality = evaluateTaskQuality(text, threshold);
    const checkOnly = Boolean(args.check && !args.polish);

    if (checkOnly) {
      await appendJsonl(paths.activity, {
        event: "task_quality_check",
        at: iso(utcNow()),
        source: label,
        score: quality.score,
        threshold: quality.threshold,
        should_polish: quality.should_polish,
      });
      console.log(JSON.stringify({
        workspace: paths.workspace,
        source: label,
        quality,
      }, null, 2));
      return;
    }

    if (args.polish && !quality.should_polish) {
      let compiledProgram: string | null = null;
      if (args.compile) {
        const compiled = await buildCompiledProgram(initialConfig, paths);
        await writeJson(paths.compiled_program, compiled);
        await syncSectionStateFromTask(initialConfig.product_doc, paths, "task quality accepted and compiled");
        compiledProgram = paths.compiled_program;
      }
      await appendJsonl(paths.activity, {
        event: "task_quality_accept",
        at: iso(utcNow()),
        source: label,
        score: quality.score,
        threshold: quality.threshold,
        compiled_program: compiledProgram,
      });
      console.log(JSON.stringify({
        workspace: paths.workspace,
        source: label,
        quality,
        skipped_planning: true,
        reason: "task quality meets threshold",
        compiled_program: compiledProgram,
      }, null, 2));
      return;
    }

    const { payload, usage } = await polishTaskText(initialConfig, paths, label, text);
    const plannedTask = payload.planned_task_markdown;
    const actualSectionCount = countTaskSections(plannedTask);
    const plannedQuality = evaluateTaskQuality(plannedTask, threshold);
    const review: TaskPlanResult & {
      source: string;
      planned_at: string;
      output_path: string | null;
      applied: boolean;
      compiled: boolean;
      usage: AgentUsage;
      quality_before: TaskQualityReport;
      quality_after: TaskQualityReport;
    } = {
      ...payload,
      planned_task_markdown: plannedTask,
      section_count: actualSectionCount,
      source: label,
      planned_at: iso(utcNow()),
      output_path: null,
      applied: Boolean(args.apply),
      compiled: Boolean(args.compile),
      usage,
      quality_before: quality,
      quality_after: plannedQuality,
    };

    const outputPath = args.output && args.output.trim()
      ? resolveWorkspacePath(paths.workspace, args.output)
      : null;
    if (outputPath) {
      await writeText(outputPath, plannedTask);
      review.output_path = outputPath;
    }

    let backupPath: string | null = null;
    if (args.apply) {
      const original = await readFile(initialConfig.product_doc, "utf-8");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      backupPath = `${paths.compiled_dir}/${basename(initialConfig.product_doc)}.before-plan-${stamp}.md`;
      await writeText(backupPath, original);
      await writeText(initialConfig.product_doc, plannedTask);
      await syncSectionStateFromTask(initialConfig.product_doc, paths, "task document replanned by tns plan");
    }

    let compiledProgram: string | null = null;
    if (args.compile) {
      const compiled = await buildCompiledProgram(initialConfig, paths);
      await writeJson(paths.compiled_program, compiled);
      await syncSectionStateFromTask(initialConfig.product_doc, paths, "task document planned and compiled");
      compiledProgram = paths.compiled_program;
    }

    await writeJson(paths.task_plan_review, review);
    await appendJsonl(paths.activity, {
      event: "task_plan",
      at: iso(utcNow()),
      source: label,
      section_count: actualSectionCount,
      applied: Boolean(args.apply),
      output_path: outputPath,
      backup_path: backupPath,
      compiled_program: compiledProgram,
      quality_before: quality.score,
      quality_after: plannedQuality.score,
    });

    console.log(JSON.stringify({
      workspace: paths.workspace,
      source: label,
      quality_before: quality,
      quality_after: plannedQuality,
      task_plan_review: paths.task_plan_review,
      output: outputPath,
      applied: Boolean(args.apply),
      backup: backupPath,
      compiled_program: compiledProgram,
      section_count: actualSectionCount,
      confidence: payload.confidence,
      warnings: payload.warnings ?? [],
      task_path_exists: await pathExists(initialConfig.product_doc),
    }, null, 2));
  });
}
