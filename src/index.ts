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

interface CommonArgs {
  config: string;
}

async function main() {
  const rawArgs = hideBin(process.argv);
  if (rawArgs[0] === "help") {
    await cmdHelp({ topic: rawArgs[1] });
    return;
  }
  const argv = await yargs(rawArgs)
    .command("help [topic]", "Show TNS help", (y) =>
      y.positional("topic", { type: "string", choices: ["init", "run", "config", "permissions", "exploration", "status", "tmux", "btw"] })
    )
    .command("init", "Initialize TNS state or scaffold a workspace", (y) =>
      y.option("config", { type: "string" })
        .option("workspace", { type: "string" })
        .option("task", { type: "string" })
        .option("template", { type: "string", choices: ["blank", "novel-writing", "audiobook-video"], default: "blank" })
        .option("runner", { type: "string", choices: ["auto", "direct", "tmux"], default: "auto" })
        .option("force", { type: "boolean", default: false })
    )
    .command("status", "Show TNS status", (y) => y.option("config", { type: "string", demandOption: true }))
    .command("btw", "Read-only live snapshot for a running TNS workspace", (y) =>
      y.option("config", { type: "string", demandOption: true })
        .option("events", { type: "number", default: 8 })
        .option("reviews", { type: "number", default: 3 })
    )
    .command("approve", "Grant a named escalated permission tag for this workspace", (y) =>
      y.option("config", { type: "string", demandOption: true })
        .option("tag", { type: "string", demandOption: true })
        .option("note", { type: "string" })
    )
    .command("revoke", "Revoke a previously granted permission tag", (y) =>
      y.option("config", { type: "string", demandOption: true })
        .option("tag", { type: "string", demandOption: true })
    )
    .command("reindex-artifacts", "Rebuild artifact index from activity log", (y) =>
      y.option("config", { type: "string", demandOption: true })
    )
    .command("run", "Run TNS loop", (y) =>
      y.option("config", { type: "string", demandOption: true })
        .option("once", { type: "boolean", default: false })
        .option("poll-seconds", { type: "number", default: 60 })
    )
    .command("start", "Start configured TNS runner", (y) =>
      y.option("config", { type: "string", demandOption: true })
        .option("once", { type: "boolean", default: false })
        .option("poll-seconds", { type: "number", default: 60 })
        .option("restart", { type: "boolean", default: false })
    )
    .command("run-tmux", "Run TNS in tmux", (y) =>
      y.option("config", { type: "string", demandOption: true })
        .option("poll-seconds", { type: "number", default: 60 })
        .option("once", { type: "boolean", default: false })
        .option("restart", { type: "boolean", default: false })
    )
    .command("freeze", "Freeze TNS", (y) =>
      y.option("config", { type: "string", demandOption: true })
        .option("reason", { type: "string" })
    )
    .command("unfreeze", "Unfreeze TNS", (y) =>
      y.option("config", { type: "string", demandOption: true })
    )
    .command("plan-import", "Import plan to TNS", (y) =>
      y.option("config", { type: "string", demandOption: true })
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
      await cmdInit(args as unknown as { config?: string; workspace?: string; task?: string; template?: "blank" | "novel-writing" | "audiobook-video"; runner?: "auto" | "direct" | "tmux"; force?: boolean });
      break;
    case "status":
      await cmdStatus(args as unknown as { config: string });
      break;
    case "btw":
      await cmdBtw(args as unknown as { config: string; events?: number; reviews?: number });
      break;
    case "approve":
      await cmdApprove(args as unknown as { config: string; tag: string; note?: string });
      break;
    case "revoke":
      await cmdRevoke(args as unknown as { config: string; tag: string });
      break;
    case "reindex-artifacts":
      await cmdReindexArtifacts(args as unknown as { config: string });
      break;
    case "run":
      await cmdRun(args as unknown as { config: string; once?: boolean; poll_seconds?: number });
      break;
    case "start":
      await cmdStart(args as unknown as { config: string; once?: boolean; poll_seconds?: number; pollSeconds?: number; restart?: boolean });
      break;
    case "run-tmux":
      await cmdRunTmx(args as unknown as { config: string; poll_seconds?: number; pollSeconds?: number; restart?: boolean; once?: boolean });
      break;
    case "freeze":
      await cmdFreeze(args as unknown as { config: string; reason?: string });
      break;
    case "unfreeze":
      await cmdUnfreeze(args as unknown as { config: string });
      break;
    case "plan-import":
      await cmdPlanImport(args as unknown as { config: string; plan_file: string; merge: boolean });
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
