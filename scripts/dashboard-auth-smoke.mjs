import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(new URL("..", import.meta.url).pathname);
const workspace = mkdtempSync(resolve(tmpdir(), "tns-dashboard-auth-"));
const port = 49173 + Math.floor(Math.random() * 1000);
const dashboardUrl = `http://127.0.0.1:${port}/`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function run(args, cwd = root) {
  const result = spawnSync("node", [resolve(root, "dist/index.js"), ...args], {
    cwd,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(`command failed: tns ${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  }
  return result.stdout;
}

function dashboardFor(path) {
  return JSON.parse(readFileSync(resolve(path, ".tns/dashboard.json"), "utf-8"));
}

async function waitForServer(child) {
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`${dashboardUrl}healthz`);
      if (res.ok) {
        return output;
      }
    } catch {
      // wait for listen
    }
    await delay(100);
  }
  throw new Error(`dashboard server did not start\n${output}`);
}

async function jsonFetch(path, options = {}) {
  const res = await fetch(`${dashboardUrl}${path}`, options);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { res, body };
}

let child;
let childWorkspaceForCleanup = null;
try {
  run(["init", "--workspace", workspace, "--runner", "direct", "--dashboard", "--dashboard-url", dashboardUrl]);
  const dashboard = dashboardFor(workspace);
  assert(/^[0-9a-f]{4}-[0-9a-f]{4}$/.test(dashboard.key), "dashboard key must match xxxx-xxxx");
  assert(!String(dashboard.frontend_url).includes("anonir.tech"), "dashboard URL must not default to anonir.tech");

  child = spawn("node", [
    resolve(root, "dist/index.js"),
    "gateway",
    "web",
    "--config",
    resolve(workspace, "tns_config.json"),
    "--port",
    String(port),
    "--poll-ms",
    "500",
  ], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer(child);

  let out = await jsonFetch("api/snapshot");
  assert(out.res.status === 401, "snapshot without key must be rejected");

  out = await jsonFetch("api/snapshot?key=bad0-bad0");
  assert(out.res.status === 401, "snapshot with wrong key must be rejected");

  out = await jsonFetch(`api/snapshot?key=${dashboard.key}`);
  assert(out.res.status === 200, "snapshot with correct key must succeed");
  assert(out.body.workspace === workspace, "snapshot should return requested workspace");
  assert(out.body.dashboard && !("key" in out.body.dashboard), "snapshot must redact dashboard key");

  out = await jsonFetch(`api/workspaces?key=${dashboard.key}`);
  assert(out.res.status === 200, "workspaces with correct key must succeed");
  assert(Array.isArray(out.body.workspaces), "workspaces must be an array");

  out = await jsonFetch("api/workspaces/init", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "no-key", task: "# Task\n\n## A\nA\n" }),
  });
  assert(out.res.status === 401, "init without key must be rejected");

  out = await jsonFetch("api/workspaces/init", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tns-dashboard-key": dashboard.key,
    },
    body: JSON.stringify({ name: `child-${Date.now()}`, task: "# Task\n\n## A\nA\n", dashboard: true }),
  });
  assert(out.res.status === 200, "init with key must succeed");
  const childWorkspace = out.body.workspace;
  childWorkspaceForCleanup = childWorkspace;
  const childKey = out.body.result.dashboard.key;
  assert(childWorkspace && childWorkspace !== workspace, "child workspace should be distinct");
  assert(/^[0-9a-f]{4}-[0-9a-f]{4}$/.test(childKey), "child dashboard key must match xxxx-xxxx");
  assert(childKey !== dashboard.key, "child key must be unique");

  out = await jsonFetch(`api/snapshot?workspace=${encodeURIComponent(childWorkspace)}&key=${dashboard.key}`);
  assert(out.res.status === 401, "parent key must not authorize child workspace");

  out = await jsonFetch(`api/snapshot?workspace=${encodeURIComponent(childWorkspace)}&key=${childKey}`);
  assert(out.res.status === 200, "child key must authorize child workspace");
  assert(out.body.workspace === childWorkspace, "child snapshot should return child workspace");

  out = await jsonFetch(`api/events?workspace=${encodeURIComponent(childWorkspace)}&key=${childKey}`);
  assert(out.res.status === 200, "events should authorize against selected workspace");

  console.log(JSON.stringify({
    ok: true,
    workspace,
    child_workspace: childWorkspace,
  }, null, 2));
} finally {
  if (child && !child.killed) {
    child.kill("SIGTERM");
  }
  rmSync(workspace, { recursive: true, force: true });
  if (childWorkspaceForCleanup) {
    rmSync(childWorkspaceForCleanup, { recursive: true, force: true });
  }
}
