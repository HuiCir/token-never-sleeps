import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { dashboardHtml } from "../web/dashboard.js";
import { ensureInitialized } from "../core/state.js";
import { loadRuntime } from "../core/runtime.js";
import { loadConfig, workflowSettings } from "../lib/config.js";
import { pathExists, readJson } from "../lib/fs.js";
import { pidIsAlive, readAllResourceLocks, readWorkspaceLock } from "../lib/lock.js";
import { skillbaseSettings } from "../lib/skillbase.js";
import { iso, utcNow } from "../lib/time.js";
import type { Section, StatePaths, TnsConfig } from "../types.js";
import { initWorkspace } from "./init.js";

export interface GatewayWebArgs {
  config?: string;
  host?: string;
  port?: number;
  poll_ms?: number;
  pollMs?: number;
  duration_seconds?: number;
  durationSeconds?: number;
  compact?: boolean;
}

type JsonRecord = Record<string, unknown>;
type TemplateName = "blank" | "novel-writing";

interface WorkspaceContext {
  config: TnsConfig;
  paths: StatePaths;
}

class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function readJsonlTail<T extends JsonRecord>(path: string, limit: number): Promise<T[]> {
  try {
    const content = await readFile(path, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    return lines.slice(-limit).flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

async function readTextPreview(path: string, maxChars: number): Promise<{ exists: boolean; bytes: number; preview: string }> {
  try {
    const content = await readFile(path, "utf-8");
    return {
      exists: true,
      bytes: Buffer.byteLength(content, "utf-8"),
      preview: content.slice(0, maxChars),
    };
  } catch {
    return { exists: false, bytes: 0, preview: "" };
  }
}

async function readAgentRuns(paths: StatePaths, limit: number): Promise<JsonRecord[]> {
  try {
    const names = await readdir(paths.agent_runs_dir);
    const files = names.filter((name) => name.endsWith(".json")).slice(-limit);
    const runs: Array<JsonRecord | null> = await Promise.all(files.map(async (name) => {
      const payload = await readJson<JsonRecord>(resolve(paths.agent_runs_dir, name));
      return payload ? { file: name, ...payload } : null;
    }));
    return runs.filter((run): run is JsonRecord => run !== null);
  } catch {
    return [];
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string" && item.length > 0);
}

function normalizeSectionId(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "workspace";
}

function extractSkills(event: JsonRecord): string[] {
  return Array.from(new Set([
    ...stringArray(event.injected_skills),
    ...stringArray(event.skills),
    ...stringArray(event.auto_skills),
    ...stringArray(event.explicit_skills),
  ]));
}

function sectionCounts(sections: Section[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const section of sections) {
    counts[section.status] = (counts[section.status] ?? 0) + 1;
  }
  return counts;
}

function deriveSkillInjections(activity: JsonRecord[], injectionEvents: JsonRecord[]): JsonRecord[] {
  const fromActivity: JsonRecord[] = activity
    .filter((event) => event.event === "agent_start")
    .map((event) => ({
      at: event.at,
      section: event.section,
      step: event.step,
      agent: event.agent,
      skills: extractSkills(event),
      skill_matches: event.skill_matches ?? null,
      source: "activity",
    }))
    .filter((event) => stringArray(event.skills).length > 0 || event.skill_matches);

  const fromInjection: JsonRecord[] = injectionEvents.map((event) => ({
    ...event,
    skills: extractSkills(event),
    source: typeof event.source === "string" ? event.source : "injection-events",
  }));

  return [...fromActivity, ...fromInjection]
    .sort((left, right) => String(left.at ?? "").localeCompare(String(right.at ?? "")))
    .slice(-200);
}

function deriveThreads(sections: Section[], runtime: JsonRecord | null, activity: JsonRecord[], skillInjections: JsonRecord[]): JsonRecord[] {
  const sectionsById = new Map(sections.map((section) => [section.id, section]));
  const threads = new Map<string, JsonRecord>();
  const ensure = (sectionId: string): JsonRecord => {
    const id = normalizeSectionId(sectionId);
    const section = sectionsById.get(id);
    if (!threads.has(id)) {
      threads.set(id, {
        id,
        section: id,
        title: section?.title ?? id,
        status: section?.status ?? "unknown",
        active: section?.status === "in_progress",
        current_step: section?.current_step ?? "",
        current_agent: null,
        last_agent: null,
        last_step: null,
        agent_pid: null,
        parallel_batch: null,
        skills: [],
        runs: [],
      });
    }
    return threads.get(id)!;
  };

  for (const section of sections) {
    ensure(section.id);
  }

  let currentBatch: string | null = null;
  for (const event of activity) {
    const eventName = String(event.event ?? "");
    if (eventName === "parallel_batch_start") {
      currentBatch = String(event.batch_id ?? event.at ?? "");
      for (const section of stringArray(event.sections)) {
        const thread = ensure(section);
        thread.parallel_batch = currentBatch;
      }
      continue;
    }
    if (eventName === "parallel_batch_end") {
      currentBatch = null;
      continue;
    }
    if (eventName !== "agent_start" && eventName !== "agent_end") {
      continue;
    }
    const section = normalizeSectionId(event.section);
    const thread = ensure(section);
    const run = {
      event: eventName,
      at: event.at,
      agent: event.agent,
      step: event.step,
      pid: event.pid ?? event.agent_pid ?? null,
    };
    (thread.runs as JsonRecord[]).push(run);
    thread.last_agent = event.agent ?? thread.last_agent;
    thread.last_step = event.step ?? thread.last_step;
    if (eventName === "agent_start") {
      thread.current_agent = event.agent ?? thread.current_agent;
      thread.current_step = event.step ?? thread.current_step;
      thread.agent_pid = event.pid ?? event.agent_pid ?? thread.agent_pid;
      thread.active = true;
      thread.parallel_batch = event.parallel_batch ?? currentBatch ?? thread.parallel_batch;
      thread.skills = Array.from(new Set([...(stringArray(thread.skills)), ...extractSkills(event)]));
    }
    if (eventName === "agent_end") {
      thread.active = false;
    }
  }

  for (const injection of skillInjections) {
    const rawSection = injection.section ?? injection.section_id;
    if (typeof rawSection !== "string" || rawSection.length === 0) {
      continue;
    }
    const section = normalizeSectionId(rawSection);
    const thread = ensure(section);
    thread.skills = Array.from(new Set([...(stringArray(thread.skills)), ...extractSkills(injection)]));
  }

  if (runtime?.active) {
    const runtimeSections = String(runtime.current_section ?? "")
      .replace(/^parallel:/, "")
      .split(",")
      .map((section) => section.trim())
      .filter(Boolean);
    for (const section of runtimeSections.length > 0 ? runtimeSections : ["workspace"]) {
      const thread = ensure(section);
      thread.active = true;
      thread.current_agent = runtime.current_agent ?? thread.current_agent;
      thread.current_step = runtime.current_step ?? thread.current_step;
      thread.agent_pid = runtime.agent_pid ?? thread.agent_pid;
    }
  }

  return Array.from(threads.values())
    .map((thread): JsonRecord => ({
      ...thread,
      runs: asArray(thread.runs).slice(-20),
    }))
    .sort((left, right) => String(left["section"]).localeCompare(String(right["section"])));
}

function configSummary(config: TnsConfig): JsonRecord {
  const skillbases = skillbaseSettings(config);
  return {
    config_path: (config as TnsConfig & { _config_path?: string })._config_path ?? null,
    workspace: config.workspace,
    product_doc: config.product_doc,
    thread: config.thread ?? null,
    threads: config.threads ?? null,
    workflow: workflowSettings(config),
    exploration: config.exploration ?? null,
    tmux: config.tmux ?? null,
    monitor: config.monitor ?? null,
    permission_profiles: Object.keys(config.permissions?.profiles ?? {}),
    validators: config.validators ?? [],
    command_bridge: config.command_bridge ?? null,
    skill_sources: skillbases.sources,
    skill_selection: skillbases.selection,
    injection_profiles: Object.keys(config.injections?.profiles ?? {}),
  };
}

function sameDirectory(path: string, parent: string): boolean {
  return dirname(resolve(path)) === resolve(parent);
}

function sanitizeWorkspaceName(input: unknown): string {
  const raw = typeof input === "string" ? input.trim() : "";
  const name = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 64);
  return name || `tns-web-${Date.now()}`;
}

function requestedDashboardKey(req: IncomingMessage, url: URL): string {
  const header = req.headers["x-tns-dashboard-key"];
  if (typeof header === "string" && header.trim()) {
    return header.trim();
  }
  const auth = req.headers.authorization;
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }
  return url.searchParams.get("key")?.trim() ?? "";
}

function sameSecret(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function redactDashboard(dashboard: JsonRecord | null): JsonRecord | null {
  if (!dashboard) {
    return null;
  }
  const redacted = { ...dashboard };
  if (typeof redacted.key === "string") {
    redacted.key_hint = `${redacted.key.slice(0, 2)}**-****`;
  }
  delete redacted.key;
  return redacted;
}

async function readDashboard(paths: StatePaths): Promise<JsonRecord | null> {
  return readJson<JsonRecord>(resolve(paths.workspace, ".tns", "dashboard.json"));
}

async function requireDashboardAuth(req: IncomingMessage, url: URL, paths: StatePaths): Promise<JsonRecord> {
  const dashboard = await readDashboard(paths);
  const expected = typeof dashboard?.key === "string" ? dashboard.key : "";
  if (!dashboard?.enabled || !expected) {
    throw new HttpError(403, `dashboard is not enabled for workspace: ${paths.workspace}`);
  }
  const actual = requestedDashboardKey(req, url);
  if (!actual || !sameSecret(actual, expected)) {
    throw new HttpError(401, "invalid dashboard key");
  }
  return dashboard;
}

async function readRequestJson(req: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 128 * 1024) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as JsonRecord;
}

async function workspaceContext(defaultConfig: TnsConfig, defaultParent: string, workspaceParam: string | null): Promise<WorkspaceContext> {
  if (!workspaceParam || resolve(workspaceParam) === resolve(defaultConfig.workspace)) {
    const paths = await ensureInitialized(defaultConfig, { autoInit: false });
    return { config: defaultConfig, paths };
  }
  const workspace = resolve(workspaceParam);
  if (!sameDirectory(workspace, defaultParent)) {
    throw new Error(`workspace must be inside ${defaultParent}`);
  }
  const config = loadConfig(resolve(workspace, "tns_config.json"));
  const paths = await ensureInitialized(config, { autoInit: false });
  return { config, paths };
}

async function listSiblingWorkspaces(defaultConfig: TnsConfig, parent: string): Promise<JsonRecord[]> {
  const entries = await readdir(parent, { withFileTypes: true });
  const rows: Array<JsonRecord | null> = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const workspace = resolve(parent, entry.name);
      const configPath = resolve(workspace, "tns_config.json");
      if (!(await pathExists(configPath))) {
        return null;
      }
      const config = loadConfig(configPath);
      const paths = await ensureInitialized(config, { autoInit: false });
      const sections = await readJson<Section[]>(paths.sections, []);
      const dashboard = await readJson<JsonRecord>(resolve(workspace, ".tns", "dashboard.json"));
      const redactedDashboard = redactDashboard(dashboard);
      return {
        name: basename(workspace),
        workspace,
        config: configPath,
        default: resolve(workspace) === resolve(defaultConfig.workspace),
        sections: sections?.length ?? 0,
        dashboard_enabled: Boolean(dashboard?.enabled),
        dashboard: redactedDashboard,
      };
    }));
  return rows.filter((row): row is JsonRecord => row !== null)
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

async function initSiblingWorkspace(defaultConfig: TnsConfig, parent: string, body: JsonRecord): Promise<JsonRecord> {
  const name = sanitizeWorkspaceName(body.name);
  const workspace = resolve(parent, name);
  if (!sameDirectory(workspace, parent)) {
    throw new Error(`workspace must be inside ${parent}`);
  }
  if (resolve(workspace) === resolve(defaultConfig.workspace)) {
    throw new Error("cannot overwrite the default dashboard workspace");
  }
  if (await pathExists(workspace)) {
    throw new Error(`workspace already exists: ${workspace}`);
  }
  const threadRaw = Number(body.thread ?? body.threads ?? 1);
  const thread = Number.isFinite(threadRaw) ? Math.max(1, Math.min(8, Math.floor(threadRaw))) : 1;
  const template = body.template === "novel-writing" ? "novel-writing" : "blank";
  const runner = body.runner === "tmux" || body.runner === "auto" ? body.runner : "direct";
  const taskText = typeof body.task === "string" ? body.task : typeof body.task_text === "string" ? body.task_text : undefined;
  const dashboardUrl = typeof body.dashboard_url === "string"
    ? body.dashboard_url
    : typeof body.dashboardUrl === "string"
      ? body.dashboardUrl
      : process.env.TNS_DASHBOARD_URL || "http://127.0.0.1:48731/";
  const result = await initWorkspace({
    workspace,
    template: template as TemplateName,
    runner,
    task_text: taskText,
    thread,
    dashboard: body.dashboard !== false,
    dashboard_url: dashboardUrl,
  });
  return {
    ok: true,
    parent,
    workspace,
    result,
  };
}

export async function buildGatewayWebSnapshot(config: TnsConfig, paths: StatePaths): Promise<JsonRecord> {
  const [
    manifest,
    sections,
    reviews,
    artifacts,
    approvals,
    exploration,
    diagnostics,
    tmux,
    freeze,
    runtimeRaw,
    compiledProgram,
    compilerReview,
    taskPlanReview,
    gatewayStatus,
    gatewayClients,
    gatewayTasks,
    activity,
    gatewayEvents,
    hookEvents,
    lockEvents,
    toolEvents,
    injectionEvents,
    commandRuns,
    agentRuns,
    taskPreview,
    resourceLocks,
    workspaceLock,
    dashboard,
  ] = await Promise.all([
    readJson<JsonRecord>(paths.manifest),
    readJson<Section[]>(paths.sections, []),
    readJson<unknown[]>(paths.reviews, []),
    readJson<unknown[]>(paths.artifacts, []),
    readJson<JsonRecord>(paths.approvals),
    readJson<JsonRecord>(paths.exploration),
    readJson<JsonRecord>(paths.diagnostics),
    readJson<JsonRecord>(paths.tmux),
    readJson<JsonRecord>(paths.freeze),
    loadRuntime(paths) as Promise<JsonRecord | null>,
    readJson<JsonRecord>(paths.compiled_program),
    readJson<JsonRecord>(paths.compiler_review),
    readJson<JsonRecord>(paths.task_plan_review),
    readJson<JsonRecord>(paths.gateway_status),
    readJson<JsonRecord>(paths.gateway_clients, {}),
    readJson<unknown[]>(paths.gateway_tasks, []),
    readJsonlTail<JsonRecord>(paths.activity, 240),
    readJsonlTail<JsonRecord>(paths.gateway_events, 240),
    readJsonlTail<JsonRecord>(paths.hook_events, 240),
    readJsonlTail<JsonRecord>(paths.lock_events, 240),
    readJsonlTail<JsonRecord>(paths.tool_events, 120),
    readJsonlTail<JsonRecord>(paths.injection_events, 240),
    readJsonlTail<JsonRecord>(paths.command_runs, 120),
    readAgentRuns(paths, 120),
    readTextPreview(config.product_doc, 12000),
    readAllResourceLocks(paths.workspace),
    readWorkspaceLock(paths.workspace),
    readJson<JsonRecord>(resolve(paths.workspace, ".tns", "dashboard.json")),
  ]);

  const runtime = runtimeRaw
    ? {
      ...runtimeRaw,
      pid_alive: pidIsAlive(Number(runtimeRaw.pid)),
      agent_pid_alive: pidIsAlive(Number(runtimeRaw.agent_pid)),
    }
    : null;
  const skillInjections = deriveSkillInjections(activity, injectionEvents);
  const typedSections = sections ?? [];

  return {
    generated_at: iso(utcNow()),
    workspace: paths.workspace,
    manifest,
    dashboard: redactDashboard(dashboard ?? null),
    task: {
      path: config.product_doc,
      exists: taskPreview.exists,
      bytes: taskPreview.bytes,
      preview: taskPreview.preview,
    },
    config: configSummary(config),
    sections: typedSections,
    section_counts: sectionCounts(typedSections),
    runtime,
    threads: deriveThreads(typedSections, runtime, activity, skillInjections),
    skill_injections: skillInjections,
    gateway: {
      status: gatewayStatus ?? null,
      active: Boolean(gatewayStatus?.active),
      clients: gatewayClients ?? {},
      tasks: gatewayTasks ?? [],
    },
    locks: {
      workspace: workspaceLock,
      resources: resourceLocks,
    },
    activity,
    gateway_events: gatewayEvents,
    hook_events: hookEvents,
    lock_events: lockEvents,
    tool_events: toolEvents,
    injection_events: injectionEvents,
    command_runs: commandRuns,
    agent_runs: agentRuns,
    reviews: reviews ?? [],
    artifacts: artifacts ?? [],
    approvals: approvals ?? null,
    exploration: exploration ?? null,
    diagnostics: diagnostics ?? null,
    tmux: tmux ?? null,
    freeze: freeze ?? null,
    compiled_program: {
      exists: await pathExists(paths.compiled_program),
      program: compiledProgram ?? null,
      compiler_review: compilerReview ?? null,
      task_plan_review: taskPlanReview ?? null,
    },
  };
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendHtml(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(dashboardHtml);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { ok: false, error: "not found" });
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

export async function cmdGatewayWeb(args: GatewayWebArgs): Promise<void> {
  const config = loadConfig(args.config);
  const paths = await ensureInitialized(config, { autoInit: false });
  const defaultParent = dirname(paths.workspace);
  const host = args.host ?? "127.0.0.1";
  const port = Number(args.port ?? 48731);
  const pollMs = Math.max(250, Number(args.poll_ms ?? args.pollMs ?? 1500));
  const durationSeconds = args.duration_seconds ?? args.durationSeconds;
  const deadline = durationSeconds ? Date.now() + Math.max(1, Number(durationSeconds)) * 1000 : null;

  const server = createServer(async (req, res) => {
    try {
      const url = parseUrl(req);
      if (req.method === "POST" && url.pathname === "/api/workspaces/init") {
        await requireDashboardAuth(req, url, paths);
        sendJson(res, 200, await initSiblingWorkspace(config, defaultParent, await readRequestJson(req)));
        return;
      }
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        sendHtml(res);
        return;
      }
      if (url.pathname === "/healthz") {
        sendJson(res, 200, { ok: true, workspace: paths.workspace, parent: defaultParent, pid: process.pid });
        return;
      }
      if (url.pathname === "/api/workspaces") {
        await requireDashboardAuth(req, url, paths);
        sendJson(res, 200, {
          default_workspace: paths.workspace,
          parent: defaultParent,
          workspaces: await listSiblingWorkspaces(config, defaultParent),
        });
        return;
      }
      if (url.pathname === "/api/snapshot") {
        const selected = await workspaceContext(config, defaultParent, url.searchParams.get("workspace"));
        await requireDashboardAuth(req, url, selected.paths);
        sendJson(res, 200, await buildGatewayWebSnapshot(selected.config, selected.paths));
        return;
      }
      if (url.pathname === "/api/events") {
        const selected = await workspaceContext(config, defaultParent, url.searchParams.get("workspace"));
        await requireDashboardAuth(req, url, selected.paths);
        const limit = Math.max(1, Number(url.searchParams.get("limit") ?? 80));
        const [activity, gateway, hooks, locks, tools, injections] = await Promise.all([
          readJsonlTail<JsonRecord>(selected.paths.activity, limit),
          readJsonlTail<JsonRecord>(selected.paths.gateway_events, limit),
          readJsonlTail<JsonRecord>(selected.paths.hook_events, limit),
          readJsonlTail<JsonRecord>(selected.paths.lock_events, limit),
          readJsonlTail<JsonRecord>(selected.paths.tool_events, limit),
          readJsonlTail<JsonRecord>(selected.paths.injection_events, limit),
        ]);
        sendJson(res, 200, { activity, gateway, hooks, locks, tools, injections });
        return;
      }
      if (url.pathname === "/api/stream") {
        const selected = await workspaceContext(config, defaultParent, url.searchParams.get("workspace"));
        await requireDashboardAuth(req, url, selected.paths);
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          "connection": "keep-alive",
        });
        const writeSnapshot = async () => {
          const snapshot = await buildGatewayWebSnapshot(selected.config, selected.paths);
          res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
        };
        await writeSnapshot();
        const interval = setInterval(() => {
          writeSnapshot().catch((error: unknown) => {
            res.write(`event: error\ndata: ${JSON.stringify({ error: String(error) })}\n\n`);
          });
        }, pollMs);
        req.on("close", () => clearInterval(interval));
        return;
      }
      notFound(res);
    } catch (error: unknown) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      sendJson(res, statusCode, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => resolveListen());
  });

  const url = `http://${host}:${port}/`;
  console.log(JSON.stringify({
    ok: true,
    command: "tns gateway web",
    url,
    api: `${url}api/snapshot`,
    stream: `${url}api/stream`,
    workspace: paths.workspace,
    pid: process.pid,
  }, null, args.compact ? 0 : 2));

  if (deadline) {
    const remainingMs = Math.max(0, deadline - Date.now());
    setTimeout(() => server.close(), remainingMs).unref();
  }

  await new Promise<void>((resolveClose) => {
    server.on("close", resolveClose);
  });
}
