import { appendTextSync } from "../lib/fs.js";
import { readFileSync, writeFileSync } from "node:fs";
import { iso, utcNow } from "../lib/time.js";

const MAX_HANDOFF_LINES = 500;
const KEEP_RECENT_LINES = 100;

export function appendHandoff(
  handoffPath: string,
  title: string,
  body: Record<string, unknown>,
  sectionId: string
): void {
  const text = `\n## ${title} | ${iso(utcNow())}\n\n- section: ${sectionId}\n- payload: \`${JSON.stringify(body, null, 0)}\`\n`;
  appendTextSync(handoffPath, text);

  // Rotate if too large
  try {
    const content = readFileSync(handoffPath, "utf-8");
    const lines = content.split("\n");
    if (lines.length > MAX_HANDOFF_LINES) {
      const truncated =
        lines.slice(0, 50).join("\n") +
        "\n# ... (earlier entries truncated) ...\n" +
        lines.slice(-KEEP_RECENT_LINES).join("\n");
      writeFileSync(handoffPath, truncated, "utf-8");
    }
  } catch {
    // File might not exist yet
  }
}
