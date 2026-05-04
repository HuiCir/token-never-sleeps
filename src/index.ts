#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { cmdInit } from "./commands/init.js";
import { cmdStatus } from "./commands/status.js";
import { cmdRun } from "./commands/run.js";
import { cmdFreeze, cmdUnfreeze } from "./commands/freeze.js";
import { cmdPlanImport } from "./commands/plan-import.js";
import { cmdRunTmx } from "./commands/run-tmux.js";
import { cmdReindexArtifacts } from "./commands/reindex-artifacts.js";
import { cmdStart } from "./commands/start.js";
import { cmdHelp } from "./commands/help.js";
import { cmdBtw } from "./commands/btw.js";
import { cmdApprove, cmdRevoke } from "./commands/approve.js";
import { cmdDoctor } from "./commands/doctor.js";
import { cmdRecover } from "./commands/recover.js";
import { cmdTrace } from "./commands/trace.js";
import { cmdCompile } from "./commands/compile.js";
import { cmdSkill, cmdSkills } from "./commands/skills.js";

async function main() {
  const rawArgs = hideBin(process.argv);
  if (rawArgs[0] === "help") {
    await cmdHelp({ topic: rawArgs[1] });
    return;
  }
  const argv = await yargs(rawArgs)
    .command("help [topic]", "Show TNS help", (y) =>
      y.positional("topic", { type: "string", choices: ["init", "run", "config", "permissions", "exploration", "status", "tmux", "btw", "policy", "doctor", "compile", "skills"] })
    )
    .command("init", "Initialize TNS state or scaffold a workspace", (y) =>
      y.option("config", { type: "string" })
        .option("workspace", { type: "string" })
        .option("task", { type: "string" })
        .option("template", { type: "string", choices: ["blank", "novel-writing"], default: "blank" })
        .option("runner", { type: "string", choices: ["auto", "direct", "tmux"], default: "auto" })
        .option("force", { type: "boolean", default: false })
    )
    .command("status", "Show TNS status", (y) => y.option("config", { type: "string" }))
    .command("compile", "Compile task.md and config into a deterministic orchestration program", (y) =>
      y.option("config", { type: "string" })
        .option("synthesize", { type: "boolean", default: false })
        .option("apply", { type: "boolean", default: false })
    )
    .command("skills", "Inspect configured skillbases", (y) =>
      y.option("config", { type: "string" })
        .option("action", { type: "string", choices: ["doctor", "list", "resolve", "match"], default: "doctor" })
        .option("name", { type: "string" })
        .option("source", { type: "array" })
        .option("text", { type: "string" })
        .option("file", { type: "string" })
        .option("limit", { type: "number" })
        .option("compact", { type: "boolean", default: false })
    )
    .command("skill [action] [name]", "Manage configured skill sources and installed skill bindings", (y) =>
      y.positional("action", {
        type: "string",
        choices: ["doctor", "list", "resolve", "match", "source-list", "source-add", "source-remove", "install", "uninstall"],
        default: "doctor",
      })
        .positional("name", { type: "string" })
        .option("config", { type: "string" })
        .option("source", { type: "array" })
        .option("path", { type: "string" })
        .option("id", { type: "string" })
        .option("kind", { type: "string", choices: ["auto", "skillbase", "plugin", "skills_dir"], default: "auto" })
        .option("priority", { type: "number" })
        .option("profile", { type: "string" })
        .option("mode", { type: "string", choices: ["executor", "verifier", "compile"], default: "executor" })
        .option("text", { type: "string" })
        .option("file", { type: "string" })
        .option("limit", { type: "number" })
        .option("disable-default-sources", { type: "boolean", default: false })
        .option("compact", { type: "boolean", default: false })
    )
    .command("doctor", "Run preflight and environment diagnostics", (y) =>
      y.option("config", { type: "string" })
    )
    .command("trace", "Show recent activity trace", (y) =>
      y.option("config", { type: "string" })
        .option("section", { type: "string" })
        .option("limit", { type: "number", default: 30 })
    )
    .command("recover", "Clear stale runtime/lock state and recover interrupted sections", (y) =>
      y.option("config", { type: "string" })
        .option("force", { type: "boolean", default: false })
    )
    .command("btw", "Read-only live snapshot for a running TNS workspace", (y) =>
      y.option("config", { type: "string" })
        .option("events", { type: "number", default: 8 })
        .option("reviews", { type: "number", default: 3 })
    )
    .command("approve", "Grant a named escalated permission tag for this workspace", (y) =>
      y.option("config", { type: "string" })
        .option("tag", { type: "string", demandOption: true })
        .option("note", { type: "string" })
    )
    .command("revoke", "Revoke a previously granted permission tag", (y) =>
      y.option("config", { type: "string" })
        .option("tag", { type: "string", demandOption: true })
    )
    .command("reindex-artifacts", "Rebuild artifact index from activity log", (y) =>
      y.option("config", { type: "string" })
    )
    .command("run", "Run TNS loop", (y) =>
      y.option("config", { type: "string" })
        .option("once", { type: "boolean", default: false })
        .option("poll-seconds", { type: "number" })
    )
    .command("start", "Start configured TNS runner", (y) =>
      y.option("config", { type: "string" })
        .option("once", { type: "boolean", default: false })
        .option("poll-seconds", { type: "number" })
        .option("restart", { type: "boolean", default: false })
    )
    .command("run-tmux", "Run TNS in tmux", (y) =>
      y.option("config", { type: "string" })
        .option("poll-seconds", { type: "number" })
        .option("once", { type: "boolean", default: false })
        .option("restart", { type: "boolean", default: false })
    )
    .command("freeze", "Freeze TNS", (y) =>
      y.option("config", { type: "string" })
        .option("reason", { type: "string" })
    )
    .command("unfreeze", "Unfreeze TNS", (y) =>
      y.option("config", { type: "string" })
    )
    .command("plan-import", "Import plan to TNS", (y) =>
      y.option("config", { type: "string" })
        .option("plan-file", { type: "string", demandOption: true })
        .option("merge", { type: "boolean", default: false })
    )
    .demandCommand(1, "You must provide a command")
    .strict()
    .parse();

  const cmd = argv._[0];
  const args = argv as unknown as Record<string, unknown>;

  switch (cmd) {
    case "help":
      await cmdHelp(args as unknown as { topic?: string });
      break;
    case "init":
      await cmdInit(args as unknown as { config?: string; workspace?: string; task?: string; template?: "blank" | "novel-writing"; runner?: "auto" | "direct" | "tmux"; force?: boolean });
      break;
    case "status":
      await cmdStatus(args as unknown as { config?: string });
      break;
    case "compile":
      await cmdCompile(args as unknown as { config?: string; synthesize?: boolean; apply?: boolean });
      break;
    case "skills":
      await cmdSkills(args as unknown as { config?: string; action?: string; name?: string; source?: string[]; text?: string; file?: string; limit?: number; compact?: boolean });
      break;
    case "skill":
      await cmdSkill(args as unknown as { config?: string; action?: string; name?: string; source?: string[]; path?: string; id?: string; kind?: "auto" | "skillbase" | "plugin" | "skills_dir"; priority?: number; profile?: string; mode?: "executor" | "verifier" | "compile"; text?: string; file?: string; limit?: number; disable_default_sources?: boolean; disableDefaultSources?: boolean; compact?: boolean });
      break;
    case "doctor":
      await cmdDoctor(args as unknown as { config?: string });
      break;
    case "trace":
      await cmdTrace(args as unknown as { config?: string; section?: string; limit?: number });
      break;
    case "recover":
      await cmdRecover(args as unknown as { config?: string; force?: boolean });
      break;
    case "btw":
      await cmdBtw(args as unknown as { config?: string; events?: number; reviews?: number });
      break;
    case "approve":
      await cmdApprove(args as unknown as { config?: string; tag: string; note?: string });
      break;
    case "revoke":
      await cmdRevoke(args as unknown as { config?: string; tag: string });
      break;
    case "reindex-artifacts":
      await cmdReindexArtifacts(args as unknown as { config?: string });
      break;
    case "run":
      await cmdRun(args as unknown as { config?: string; once?: boolean; poll_seconds?: number; pollSeconds?: number });
      break;
    case "start":
      await cmdStart(args as unknown as { config?: string; once?: boolean; poll_seconds?: number; pollSeconds?: number; restart?: boolean });
      break;
    case "run-tmux":
      await cmdRunTmx(args as unknown as { config?: string; poll_seconds?: number; pollSeconds?: number; restart?: boolean; once?: boolean });
      break;
    case "freeze":
      await cmdFreeze(args as unknown as { config?: string; reason?: string });
      break;
    case "unfreeze":
      await cmdUnfreeze(args as unknown as { config?: string });
      break;
    case "plan-import":
      await cmdPlanImport(args as unknown as { config?: string; plan_file: string; merge: boolean });
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
