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
import { cmdSimulate } from "./commands/simulate.js";
import { cmdParallelDemo } from "./commands/parallel-demo.js";
import { cmdSkills } from "./commands/skills.js";

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
      y.positional("topic", { type: "string", choices: ["init", "run", "config", "permissions", "exploration", "status", "tmux", "btw", "policy", "doctor", "compile", "fsm", "skills"] })
    )
    .command("init", "Initialize TNS state or scaffold a workspace", (y) =>
      y.option("config", { type: "string" })
        .option("workspace", { type: "string" })
        .option("task", { type: "string" })
        .option("template", { type: "string", choices: ["blank", "novel-writing", "fsm-control-flow"], default: "blank" })
        .option("runner", { type: "string", choices: ["auto", "direct", "tmux"], default: "auto" })
        .option("force", { type: "boolean", default: false })
    )
    .command("status", "Show TNS status", (y) => y.option("config", { type: "string", demandOption: true }))
    .command("compile", "Compile task.md and config into a deterministic orchestration program", (y) =>
      y.option("config", { type: "string", demandOption: true })
        .option("synthesize", { type: "boolean", default: false })
        .option("apply", { type: "boolean", default: false })
    )
    .command("simulate", "Simulate the compiled/configured FSM program", (y) =>
      y.option("config", { type: "string", demandOption: true })
        .option("set", { type: "array" })
        .option("max-steps", { type: "number" })
        .option("compact", { type: "boolean", default: false })
    )
    .command("parallel-demo", "Run a manual two-Claude-thread functional demo", (y) =>
      y.option("config", { type: "string", demandOption: true })
        .option("scenario", { type: "string", choices: ["independent", "collaborative", "both"], default: "both" })
        .option("agent-timeout-seconds", { type: "number", default: 120 })
        .option("keep-sandboxes", { type: "boolean", default: false })
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
    .command("doctor", "Run preflight and environment diagnostics", (y) =>
      y.option("config", { type: "string", demandOption: true })
    )
    .command("trace", "Show recent activity trace", (y) =>
      y.option("config", { type: "string", demandOption: true })
        .option("section", { type: "string" })
        .option("limit", { type: "number", default: 30 })
    )
    .command("recover", "Clear stale runtime/lock state and recover interrupted sections", (y) =>
      y.option("config", { type: "string", demandOption: true })
        .option("force", { type: "boolean", default: false })
    )
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
      await cmdInit(args as unknown as { config?: string; workspace?: string; task?: string; template?: "blank" | "novel-writing" | "fsm-control-flow"; runner?: "auto" | "direct" | "tmux"; force?: boolean });
      break;
    case "status":
      await cmdStatus(args as unknown as { config: string });
      break;
    case "compile":
      await cmdCompile(args as unknown as { config: string; synthesize?: boolean; apply?: boolean });
      break;
    case "simulate":
      await cmdSimulate(args as unknown as { config: string; set?: string[]; max_steps?: number; maxSteps?: number; compact?: boolean });
      break;
    case "parallel-demo":
      await cmdParallelDemo(args as unknown as { config: string; scenario?: "independent" | "collaborative" | "both"; agent_timeout_seconds?: number; agentTimeoutSeconds?: number; keep_sandboxes?: boolean; keepSandboxes?: boolean });
      break;
    case "skills":
      await cmdSkills(args as unknown as { config?: string; action?: string; name?: string; source?: string[]; text?: string; file?: string; limit?: number; compact?: boolean });
      break;
    case "doctor":
      await cmdDoctor(args as unknown as { config: string });
      break;
    case "trace":
      await cmdTrace(args as unknown as { config: string; section?: string; limit?: number });
      break;
    case "recover":
      await cmdRecover(args as unknown as { config: string; force?: boolean });
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
