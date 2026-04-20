#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { cmdInit } from "./commands/init.js";
import { cmdStatus } from "./commands/status.js";
import { cmdRun } from "./commands/run.js";
import { cmdFreeze, cmdUnfreeze } from "./commands/freeze.js";
import { cmdPlanImport } from "./commands/plan-import.js";
import { cmdRunTmx } from "./commands/run-tmux.js";

interface CommonArgs {
  config: string;
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .command("init", "Initialize TNS state", (y) => y.option("config", { type: "string", demandOption: true }))
    .command("status", "Show TNS status", (y) => y.option("config", { type: "string", demandOption: true }))
    .command("run", "Run TNS loop", (y) =>
      y.option("config", { type: "string", demandOption: true })
        .option("once", { type: "boolean", default: false })
        .option("poll-seconds", { type: "number", default: 60 })
    )
    .command("run-tmux", "Run TNS in tmux", (y) =>
      y.option("config", { type: "string", demandOption: true })
        .option("poll-seconds", { type: "number", default: 60 })
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
    case "init":
      await cmdInit(args as unknown as { config: string });
      break;
    case "status":
      await cmdStatus(args as unknown as { config: string });
      break;
    case "run":
      await cmdRun(args as unknown as { config: string; once?: boolean; poll_seconds?: number });
      break;
    case "run-tmux":
      await cmdRunTmx(args as unknown as { config: string; poll_seconds?: number; restart?: boolean });
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
