import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildCommonClaudeArgs } from "../dist/core/agent.js";
import { assertFilesTouchedAllowed, resolvePermissionProfile } from "../dist/lib/permissions.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertThrows(fn, message) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, message);
}

function fakeSection() {
  return {
    id: "sec-001",
    title: "External access",
    anchor: "external-access",
    body: "Read an external dependency.",
    status: "pending",
    attempts: 0,
    verified_at: null,
    last_summary: "",
    last_review: "",
    current_step: "execute",
  };
}

function baseConfig(workspace, profileName, profile) {
  return {
    workspace,
    product_doc: resolve(workspace, "task.md"),
    permission_mode: "acceptEdits",
    effort: "low",
    agent_provider: { name: "claude", command: process.execPath },
    permissions: {
      default_profile: profileName,
      profiles: {
        [profileName]: {
          permission_mode: "acceptEdits",
          allowed_bash_commands: ["pwd", "ls", "cat"],
          ...profile,
        },
      },
      section_profiles: [],
    },
  };
}

function resolveProfile(config) {
  return resolvePermissionProfile(config, fakeSection(), "execute");
}

const workspace = mkdtempSync(resolve(tmpdir(), "tns-permission-workspace-"));
const outside = mkdtempSync(resolve(tmpdir(), "tns-permission-outside-"));
const otherOutside = mkdtempSync(resolve(tmpdir(), "tns-permission-other-"));

try {
  mkdirSync(resolve(workspace, ".tns"), { recursive: true });
  writeFileSync(resolve(workspace, "inside.txt"), "inside\n", "utf-8");
  writeFileSync(resolve(workspace, ".tns/state.json"), "{}\n", "utf-8");
  writeFileSync(resolve(outside, "dependency.txt"), "dependency\n", "utf-8");
  writeFileSync(resolve(otherOutside, "blocked.txt"), "blocked\n", "utf-8");

  const workspaceConfig = baseConfig(workspace, "workspace", { path_scope: "workspace" });
  const workspaceProfile = resolveProfile(workspaceConfig);
  assert(workspaceProfile.path_scope === "workspace", "workspace profile should resolve workspace scope");
  assertFilesTouchedAllowed(workspace, ["inside.txt"], workspaceProfile);
  assertThrows(
    () => assertFilesTouchedAllowed(workspace, [resolve(outside, "dependency.txt")], workspaceProfile),
    "workspace scope must reject outside files"
  );

  const whitelistConfig = baseConfig(workspace, "whitelist", {
    path_scope: "workspace_whitelist",
    allowed_paths: [outside],
  });
  const whitelistProfile = resolveProfile(whitelistConfig);
  assert(whitelistProfile.path_scope === "workspace_whitelist", "whitelist profile should resolve whitelist scope");
  assert(whitelistProfile.access_roots.includes(resolve(outside)), "whitelist access roots must include outside path");
  assertFilesTouchedAllowed(workspace, [resolve(outside, "dependency.txt")], whitelistProfile);
  assertThrows(
    () => assertFilesTouchedAllowed(workspace, [resolve(otherOutside, "blocked.txt")], whitelistProfile),
    "whitelist scope must reject non-whitelisted outside files"
  );
  assertThrows(
    () => assertFilesTouchedAllowed(workspace, [".tns/state.json"], whitelistProfile),
    "whitelist scope must reject protected .tns state"
  );
  const whitelistArgs = buildCommonClaudeArgs(whitelistConfig, workspace, {
    permission_mode: whitelistProfile.permission_mode,
    allowed_tools: whitelistProfile.allowed_tools,
    disallowed_tools: whitelistProfile.disallowed_tools,
    access_roots: whitelistProfile.access_roots,
  });
  assert(whitelistArgs.includes(resolve(outside)), "whitelist roots must be passed as --add-dir");

  const globalConfig = baseConfig(workspace, "global", { path_scope: "global" });
  const globalProfile = resolveProfile(globalConfig);
  assert(globalProfile.path_scope === "global", "global profile should resolve global scope");
  assert(globalProfile.access_roots.includes("/"), "global profile must include / access root");
  assertFilesTouchedAllowed(workspace, [resolve(otherOutside, "blocked.txt")], globalProfile);
  assertThrows(
    () => assertFilesTouchedAllowed(workspace, [".tns/state.json"], globalProfile),
    "global scope must still reject protected .tns state"
  );
  const globalArgs = buildCommonClaudeArgs(globalConfig, workspace, {
    permission_mode: globalProfile.permission_mode,
    allowed_tools: globalProfile.allowed_tools,
    disallowed_tools: globalProfile.disallowed_tools,
    access_roots: globalProfile.access_roots,
  });
  assert(globalArgs.includes("/"), "global root must be passed as --add-dir");

  console.log(JSON.stringify({
    ok: true,
    workspace,
    outside,
    scopes: [workspaceProfile.path_scope, whitelistProfile.path_scope, globalProfile.path_scope],
  }, null, 2));
} finally {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  rmSync(otherOutside, { recursive: true, force: true });
}
