import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../lib/config.js";
import { appendJsonl, pathExists, readJson, writeJson } from "../lib/fs.js";
import { iso, sleep, utcNow } from "../lib/time.js";
import { readResourceLock, withResourceLocks } from "../lib/lock.js";
import { ensureInitialized, statePaths } from "../core/state.js";
import type { StatePaths } from "../types.js";

const PROTOCOL_VERSION = 1;

type GatewayAction =
  | "serve"
  | "status"
  | "register"
  | "heartbeat"
  | "send"
  | "recv"
  | "dispatch"
  | "claim"
  | "complete"
  | "wait-resource"
  | "events";

interface GatewayArgs {
  config?: string;
  action?: string;
  client?: string;
  from?: string;
  to?: string;
  type?: string;
  payload?: string;
  task?: string;
  task_type?: string;
  taskType?: string;
  task_id?: string;
  taskId?: string;
  resource?: string;
  timeout_ms?: number;
  timeoutMs?: number;
  poll_ms?: number;
  pollMs?: number;
  duration_seconds?: number;
  durationSeconds?: number;
  limit?: number;
  once?: boolean;
  wait?: boolean;
  compact?: boolean;
}

interface GatewayCommand {
  id: string;
  kind: string;
  at: string;
  client_id?: string;
  client_pid?: number;
  from?: string;
  to?: string;
  message_type?: string;
  payload?: unknown;
  task_id?: string;
  task_type?: string;
  task_title?: string;
  resource?: string;
  timeout_ms?: number;
}

interface GatewayClient {
  id: string;
  pid: number;
  registered_at: string;
  heartbeat_at: string;
  meta?: Record<string, unknown>;
}

interface GatewayTask {
  id: string;
  status: "pending" | "claimed" | "done";
  from: string;
  to?: string;
  type: string;
  title: string;
  payload?: unknown;
  claimant?: string;
  result?: unknown;
  created_at: string;
  updated_at: string;
}

interface GatewayWaiter {
  request_id: string;
  client_id: string;
  resource: string;
  created_at: string;
  deadline_at: string | null;
}

interface GatewayStatus {
  active: boolean;
  protocol_version: number;
  pid?: number;
  started_at?: string;
  heartbeat_at?: string;
  updated_at: string | null;
  processed_ids: string[];
  waiters: GatewayWaiter[];
  processed_count?: number;
}

function responsePath(paths: StatePaths, requestId: string): string {
  return resolve(paths.gateway_responses_dir, `${requestId}.json`);
}

function parsePayload(value: string | undefined): unknown {
  if (!value || value.trim().length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function compact(args: GatewayArgs): number {
  return args.compact ? 0 : 2;
}

async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    const content = await readFile(path, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

async function loadGatewayStatus(paths: StatePaths): Promise<GatewayStatus> {
  return (await readJson<GatewayStatus>(paths.gateway_status)) ?? {
    active: false,
    protocol_version: PROTOCOL_VERSION,
    updated_at: null,
    processed_ids: [],
    waiters: [],
  };
}

async function saveGatewayStatus(paths: StatePaths, status: GatewayStatus): Promise<void> {
  await writeJson(paths.gateway_status, {
    ...status,
    protocol_version: PROTOCOL_VERSION,
    updated_at: iso(utcNow()),
  });
}

async function loadClients(paths: StatePaths): Promise<Record<string, GatewayClient>> {
  return (await readJson<Record<string, GatewayClient>>(paths.gateway_clients)) ?? {};
}

async function saveClients(paths: StatePaths, clients: Record<string, GatewayClient>): Promise<void> {
  await writeJson(paths.gateway_clients, clients);
}

async function loadTasks(paths: StatePaths): Promise<GatewayTask[]> {
  return (await readJson<GatewayTask[]>(paths.gateway_tasks)) ?? [];
}

async function saveTasks(paths: StatePaths, tasks: GatewayTask[]): Promise<void> {
  await writeJson(paths.gateway_tasks, tasks);
}

async function emitGatewayEvent(paths: StatePaths, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const event: Record<string, unknown> = {
    protocol_version: PROTOCOL_VERSION,
    at: iso(utcNow()),
    workspace: paths.workspace,
    gateway_pid: process.pid,
    ...payload,
  };
  await appendJsonl(paths.gateway_events, event);
  await appendJsonl(paths.hook_events, {
    event: "gateway_hook",
    at: event.at,
    workspace: paths.workspace,
    hook_source: "gateway",
    hook_event: event.event,
    request_id: event.request_id ?? null,
    client_id: event.client_id ?? null,
    task_id: event.task_id ?? null,
    resource: event.resource ?? null,
    payload: event,
  });
  return event;
}

async function writeResponse(paths: StatePaths, requestId: string, payload: Record<string, unknown>): Promise<void> {
  await writeJson(responsePath(paths, requestId), {
    protocol_version: PROTOCOL_VERSION,
    request_id: requestId,
    responded_at: iso(utcNow()),
    ...payload,
  });
}

async function waitForResponse(paths: StatePaths, requestId: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const response = await readJson<Record<string, unknown>>(responsePath(paths, requestId));
    if (response) return response;
    await sleep(0.1);
  }
  throw new Error(`gateway response timeout for request ${requestId}`);
}

async function submitCommand(paths: StatePaths, command: GatewayCommand, waitMs: number): Promise<Record<string, unknown>> {
  await mkdir(paths.gateway_responses_dir, { recursive: true });
  await appendJsonl(paths.gateway_inbox, command as unknown as Record<string, unknown>);
  if (waitMs <= 0) {
    return { queued: true, request_id: command.id };
  }
  return waitForResponse(paths, command.id, waitMs);
}

function clientId(args: GatewayArgs): string {
  return args.client || args.from || `client-${process.pid}`;
}

function responseWaitMs(args: GatewayArgs): number {
  if (args.wait === false) return 0;
  return Math.max(1, Number(args.timeout_ms ?? args.timeoutMs ?? 30000));
}

async function processReadyWaiters(paths: StatePaths, status: GatewayStatus): Promise<boolean> {
  const remaining: GatewayWaiter[] = [];
  let changed = false;
  for (const waiter of status.waiters ?? []) {
    const deadline = waiter.deadline_at ? Date.parse(waiter.deadline_at) : NaN;
    if (!Number.isNaN(deadline) && deadline <= Date.now()) {
      await emitGatewayEvent(paths, {
        event: "gateway_resource_wait_timeout",
        request_id: waiter.request_id,
        client_id: waiter.client_id,
        resource: waiter.resource,
      });
      await writeResponse(paths, waiter.request_id, {
        ok: false,
        timeout: true,
        resource: waiter.resource,
        error: `resource wait timed out: ${waiter.resource}`,
      });
      changed = true;
      continue;
    }
    const holder = await readResourceLock(paths.workspace, waiter.resource);
    if (!holder) {
      await emitGatewayEvent(paths, {
        event: "gateway_resource_ready",
        request_id: waiter.request_id,
        client_id: waiter.client_id,
        resource: waiter.resource,
      });
      await writeResponse(paths, waiter.request_id, {
        ok: true,
        ready: true,
        resource: waiter.resource,
      });
      changed = true;
      continue;
    }
    remaining.push(waiter);
  }
  if (changed) {
    status.waiters = remaining;
  }
  return changed;
}

async function processCommand(paths: StatePaths, command: GatewayCommand, status: GatewayStatus): Promise<void> {
  const now = iso(utcNow());
  if (command.kind === "register" || command.kind === "heartbeat") {
    const id = command.client_id || command.from || `client-${command.id}`;
    const clients = await loadClients(paths);
    const prior = clients[id];
    clients[id] = {
      id,
      pid: command.client_pid ?? process.pid,
      registered_at: prior?.registered_at ?? now,
      heartbeat_at: now,
      meta: typeof command.payload === "object" && command.payload !== null && !Array.isArray(command.payload)
        ? command.payload as Record<string, unknown>
        : undefined,
    };
    await saveClients(paths, clients);
    const event = await emitGatewayEvent(paths, {
      event: command.kind === "register" ? "gateway_client_registered" : "gateway_client_heartbeat",
      request_id: command.id,
      client_id: id,
      payload: command.payload ?? null,
    });
    await writeResponse(paths, command.id, { ok: true, event, client: clients[id] });
    return;
  }

  if (command.kind === "send") {
    const event = await emitGatewayEvent(paths, {
      event: "gateway_message",
      request_id: command.id,
      correlation_id: command.id,
      from: command.from ?? command.client_id ?? null,
      to: command.to ?? null,
      message_type: command.message_type ?? "message",
      payload: command.payload ?? null,
    });
    await writeResponse(paths, command.id, { ok: true, event });
    return;
  }

  if (command.kind === "dispatch") {
    const tasks = await loadTasks(paths);
    const task: GatewayTask = {
      id: command.task_id || `task-${randomUUID()}`,
      status: "pending",
      from: command.from ?? command.client_id ?? "unknown",
      to: command.to || undefined,
      type: command.task_type || "task",
      title: command.task_title || command.task_type || "Gateway task",
      payload: command.payload ?? null,
      created_at: now,
      updated_at: now,
    };
    tasks.push(task);
    await saveTasks(paths, tasks);
    const event = await emitGatewayEvent(paths, {
      event: "gateway_task_dispatched",
      request_id: command.id,
      task_id: task.id,
      from: task.from,
      to: task.to ?? null,
      task_type: task.type,
      task_title: task.title,
      payload: task.payload ?? null,
    });
    await writeResponse(paths, command.id, { ok: true, task, event });
    return;
  }

  if (command.kind === "claim") {
    const client = command.client_id || command.from || "unknown";
    const tasks = await loadTasks(paths);
    const task = tasks.find((item) =>
      item.status === "pending" &&
      (!command.task_id || item.id === command.task_id) &&
      (!command.task_type || item.type === command.task_type) &&
      (!item.to || item.to === client)
    );
    if (!task) {
      await writeResponse(paths, command.id, { ok: true, task: null });
      return;
    }
    task.status = "claimed";
    task.claimant = client;
    task.updated_at = now;
    await saveTasks(paths, tasks);
    const event = await emitGatewayEvent(paths, {
      event: "gateway_task_claimed",
      request_id: command.id,
      client_id: client,
      task_id: task.id,
      task_type: task.type,
      task_title: task.title,
    });
    await writeResponse(paths, command.id, { ok: true, task, event });
    return;
  }

  if (command.kind === "complete") {
    const client = command.client_id || command.from || "unknown";
    const tasks = await loadTasks(paths);
    const task = tasks.find((item) => item.id === command.task_id);
    if (!task) {
      await writeResponse(paths, command.id, { ok: false, error: `task not found: ${command.task_id}` });
      return;
    }
    task.status = "done";
    task.claimant = task.claimant ?? client;
    task.result = command.payload ?? null;
    task.updated_at = now;
    await saveTasks(paths, tasks);
    const event = await emitGatewayEvent(paths, {
      event: "gateway_task_completed",
      request_id: command.id,
      client_id: client,
      task_id: task.id,
      task_type: task.type,
      result: task.result ?? null,
    });
    await writeResponse(paths, command.id, { ok: true, task, event });
    return;
  }

  if (command.kind === "wait_resource") {
    const client = command.client_id || command.from || "unknown";
    const resource = command.resource || "workspace";
    const holder = await readResourceLock(paths.workspace, resource);
    if (!holder) {
      const event = await emitGatewayEvent(paths, {
        event: "gateway_resource_ready",
        request_id: command.id,
        client_id: client,
        resource,
      });
      await writeResponse(paths, command.id, { ok: true, ready: true, resource, event });
      return;
    }
    const timeoutMs = Math.max(1, Number(command.timeout_ms ?? 30000));
    status.waiters = [
      ...(status.waiters ?? []),
      {
        request_id: command.id,
        client_id: client,
        resource,
        created_at: now,
        deadline_at: new Date(Date.now() + timeoutMs).toISOString(),
      },
    ];
    await emitGatewayEvent(paths, {
      event: "gateway_resource_waiting",
      request_id: command.id,
      client_id: client,
      resource,
      holder,
      timeout_ms: timeoutMs,
    });
    return;
  }

  await writeResponse(paths, command.id, { ok: false, error: `unknown gateway command: ${command.kind}` });
}

async function serveOnce(paths: StatePaths, status: GatewayStatus): Promise<GatewayStatus> {
  const commands = await readJsonl<GatewayCommand>(paths.gateway_inbox);
  const processed = new Set(status.processed_ids ?? []);
  for (const command of commands) {
    if (!command?.id || processed.has(command.id)) continue;
    try {
      await processCommand(paths, command, status);
    } catch (error: unknown) {
      await emitGatewayEvent(paths, {
        event: "gateway_command_error",
        request_id: command.id,
        command_kind: command.kind,
        error: String(error),
      });
      await writeResponse(paths, command.id, { ok: false, error: String(error) });
    }
    processed.add(command.id);
  }
  await processReadyWaiters(paths, status);
  status.processed_ids = Array.from(processed).slice(-2000);
  status.processed_count = status.processed_ids.length;
  return status;
}

async function cmdGatewayServe(paths: StatePaths, args: GatewayArgs): Promise<void> {
  const pollMs = Math.max(50, Number(args.poll_ms ?? args.pollMs ?? 250));
  const durationSeconds = args.duration_seconds ?? args.durationSeconds;
  const deadline = durationSeconds ? Date.now() + Math.max(1, Number(durationSeconds)) * 1000 : null;
  await withResourceLocks(paths.workspace, ["gateway"], "tns gateway serve", async () => {
    let status = await loadGatewayStatus(paths);
    status = {
      ...status,
      active: true,
      protocol_version: PROTOCOL_VERSION,
      pid: process.pid,
      started_at: iso(utcNow()),
      heartbeat_at: iso(utcNow()),
      waiters: status.waiters ?? [],
      processed_ids: status.processed_ids ?? [],
    };
    await saveGatewayStatus(paths, status);
    await emitGatewayEvent(paths, { event: "gateway_started" });
    try {
      while (true) {
        status.heartbeat_at = iso(utcNow());
        status = await serveOnce(paths, status);
        await saveGatewayStatus(paths, status);
        if (args.once) break;
        if (deadline && Date.now() >= deadline) break;
        await sleep(pollMs / 1000);
      }
    } finally {
      status.active = false;
      status.heartbeat_at = iso(utcNow());
      await saveGatewayStatus(paths, status);
      await emitGatewayEvent(paths, { event: "gateway_stopped" });
    }
  }, { waitMs: 1000 });
}

async function cmdSubmit(paths: StatePaths, args: GatewayArgs, command: GatewayCommand): Promise<void> {
  const response = await submitCommand(paths, command, responseWaitMs(args));
  console.log(JSON.stringify(response, null, compact(args)));
}

async function cmdRecv(paths: StatePaths, args: GatewayArgs): Promise<void> {
  const client = clientId(args);
  const limit = Math.max(1, Number(args.limit ?? 20));
  const events = await readJsonl<Record<string, unknown>>(paths.gateway_events);
  const messages = events
    .filter((event) => event.event === "gateway_message" && event.to === client)
    .slice(-limit);
  console.log(JSON.stringify({
    client,
    count: messages.length,
    messages,
  }, null, compact(args)));
}

async function cmdEvents(paths: StatePaths, args: GatewayArgs): Promise<void> {
  const limit = Math.max(1, Number(args.limit ?? 50));
  const events = (await readJsonl<Record<string, unknown>>(paths.gateway_events)).slice(-limit);
  console.log(JSON.stringify({
    workspace: paths.workspace,
    count: events.length,
    events,
  }, null, compact(args)));
}

async function cmdGatewayStatus(paths: StatePaths, args: GatewayArgs): Promise<void> {
  const status = await loadGatewayStatus(paths);
  const clients = await loadClients(paths);
  const tasks = await loadTasks(paths);
  console.log(JSON.stringify({
    workspace: paths.workspace,
    status,
    clients,
    tasks,
    paths: {
      inbox: paths.gateway_inbox,
      events: paths.gateway_events,
      responses: paths.gateway_responses_dir,
      hook_events: paths.hook_events,
    },
  }, null, compact(args)));
}

export async function cmdGateway(args: GatewayArgs): Promise<void> {
  const action = (args.action ?? "status") as GatewayAction;
  const config = loadConfig(args.config);
  const paths = await ensureInitialized(config, { autoInit: false });
  await mkdir(paths.gateway_dir, { recursive: true });
  await mkdir(paths.gateway_responses_dir, { recursive: true });

  if (action === "serve") {
    await cmdGatewayServe(paths, args);
    return;
  }
  if (action === "status") {
    await cmdGatewayStatus(paths, args);
    return;
  }
  if (action === "recv") {
    await cmdRecv(paths, args);
    return;
  }
  if (action === "events") {
    await cmdEvents(paths, args);
    return;
  }

  const id = randomUUID();
  const at = iso(utcNow());
  if (action === "register") {
    await cmdSubmit(paths, args, {
      id,
      at,
      kind: "register",
      client_id: clientId(args),
      client_pid: process.pid,
      payload: parsePayload(args.payload),
    });
    return;
  }
  if (action === "heartbeat") {
    await cmdSubmit(paths, args, {
      id,
      at,
      kind: "heartbeat",
      client_id: clientId(args),
      client_pid: process.pid,
      payload: parsePayload(args.payload),
    });
    return;
  }
  if (action === "send") {
    await cmdSubmit(paths, args, {
      id,
      at,
      kind: "send",
      from: args.from || clientId(args),
      to: args.to,
      message_type: args.type || "message",
      payload: parsePayload(args.payload),
    });
    return;
  }
  if (action === "dispatch") {
    await cmdSubmit(paths, args, {
      id,
      at,
      kind: "dispatch",
      from: args.from || clientId(args),
      to: args.to,
      task_type: args.task_type ?? args.taskType ?? args.type ?? "task",
      task_title: args.task || "Gateway task",
      payload: parsePayload(args.payload),
    });
    return;
  }
  if (action === "claim") {
    await cmdSubmit(paths, args, {
      id,
      at,
      kind: "claim",
      client_id: clientId(args),
      task_id: args.task_id ?? args.taskId,
      task_type: args.task_type ?? args.taskType ?? args.type,
    });
    return;
  }
  if (action === "complete") {
    await cmdSubmit(paths, args, {
      id,
      at,
      kind: "complete",
      client_id: clientId(args),
      task_id: args.task_id ?? args.taskId,
      payload: parsePayload(args.payload),
    });
    return;
  }
  if (action === "wait-resource") {
    await cmdSubmit(paths, args, {
      id,
      at,
      kind: "wait_resource",
      client_id: clientId(args),
      resource: args.resource || "workspace",
      timeout_ms: Math.max(1, Number(args.timeout_ms ?? args.timeoutMs ?? 30000)),
    });
    return;
  }

  throw new Error(`unknown gateway action: ${action}`);
}
