import { appendJsonl, readJson, removePath } from "../lib/fs.js";
import { loadConfig } from "../lib/config.js";
import { ensureInitialized } from "../core/state.js";
import { grantApproval, revokeApproval } from "../core/approvals.js";
import { withResourceLocks } from "../lib/lock.js";
import { iso, utcNow } from "../lib/time.js";

export async function cmdApprove(args: { config?: string; tag: string; note?: string }): Promise<void> {
  const config = loadConfig(args.config);
  await withResourceLocks(config.workspace, ["workspace", "control", "state"], "tns approve", async () => {
    const paths = await ensureInitialized(config, { autoInit: true });
    await grantApproval(paths, args.tag, args.note);
    const freeze = await readJson<Record<string, unknown>>(paths.freeze);
    if (freeze && typeof freeze.reason === "string" && freeze.reason === `approval_required:${args.tag}`) {
      await removePath(paths.freeze);
    }
    await appendJsonl(paths.activity, {
      event: "approval_granted",
      at: iso(utcNow()),
      approval_tag: args.tag,
      note: args.note || "",
    });
    console.log(JSON.stringify({
      approved: args.tag,
      workspace: paths.workspace,
      note: args.note || "",
    }, null, 2));
  });
}

export async function cmdRevoke(args: { config?: string; tag: string }): Promise<void> {
  const config = loadConfig(args.config);
  await withResourceLocks(config.workspace, ["workspace", "control", "state"], "tns revoke", async () => {
    const paths = await ensureInitialized(config, { autoInit: true });
    await revokeApproval(paths, args.tag);
    await appendJsonl(paths.activity, {
      event: "approval_revoked",
      at: iso(utcNow()),
      approval_tag: args.tag,
    });
    console.log(JSON.stringify({
      revoked: args.tag,
      workspace: paths.workspace,
    }, null, 2));
  });
}
