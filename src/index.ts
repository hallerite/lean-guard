import { plugin } from "@opencode-ai/plugin";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";

const BEGIN_MARKER = "-- lean-guard: begin protected";
const END_MARKER = "-- lean-guard: end protected";

const PROOF_FILE = process.env.LEAN_GUARD_FILE;
if (!PROOF_FILE) {
  throw new Error("[lean-guard] LEAN_GUARD_FILE environment variable is required.");
}

interface GuardInfo {
  filePath: string;
  protectedText: string;
}

const guardCache = new Map<string, GuardInfo>();

function parseGuardedFile(filePath: string): GuardInfo | null {
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, "utf-8");
  const beginIdx = content.indexOf(BEGIN_MARKER);
  if (beginIdx === -1) return null;

  const endIdx = content.indexOf(END_MARKER);
  if (endIdx === -1) return null;

  const endOfEndLine = content.indexOf("\n", endIdx);
  const protectedEnd = endOfEndLine === -1 ? content.length : endOfEndLine + 1;
  const protectedText = content.slice(beginIdx, protectedEnd);

  return { filePath, protectedText };
}

function isShellWriteToFile(cmd: string, filePath: string): boolean {
  const escaped = filePath.replace(/\//g, "\\/");
  const patterns = [
    new RegExp(`>\\s*${escaped}`),
    new RegExp(`sed\\s+.*-i.*${escaped}`),
    new RegExp(`tee\\s+.*${escaped}`),
    new RegExp(`cp\\s+.*${escaped}`),
    new RegExp(`mv\\s+.*${escaped}`),
    new RegExp(`cat\\s*>.*${escaped}`),
    new RegExp(`echo\\s+.*>.*${escaped}`),
    new RegExp(`printf\\s+.*>.*${escaped}`),
  ];
  return patterns.some((p) => p.test(cmd));
}

function resetFile(guard: GuardInfo): void {
  writeFileSync(guard.filePath, guard.protectedText + "  sorry\n", "utf-8");
}

export default plugin({
  name: "lean-guard",

  setup(app) {
    // Eagerly parse the proof file at init so the cache has the original
    // protected text before the agent makes any edits.
    const guard = parseGuardedFile(PROOF_FILE);
    if (guard) {
      guardCache.set(PROOF_FILE, guard);
    }

    // Before: block bash commands that write to guarded files
    app.on("tool.execute.before", (event) => {
      if (event.tool.name !== "bash") return;

      const input = event.tool.input as Record<string, unknown>;
      const command = (input.command ?? "") as string;

      for (const [, guard] of guardCache) {
        if (isShellWriteToFile(command, guard.filePath)) {
          throw new Error(
            "[lean-guard] Cannot write to the proof file via shell. Use 'edit' to modify only the proof body."
          );
        }
      }
    });

    // After: verify protected region is intact
    app.on("tool.execute.after", (event) => {
      if (!["edit", "bash"].includes(event.tool.name)) return;

      for (const [filePath, guard] of guardCache) {
        if (!existsSync(filePath)) continue;

        const content = readFileSync(filePath, "utf-8");
        const beginIdx = content.indexOf(BEGIN_MARKER);
        const endIdx = content.indexOf(END_MARKER);

        if (beginIdx === -1 || endIdx === -1) {
          resetFile(guard);
          const output = event.output as { output?: string };
          output.output = (output.output ?? "") +
            "\n[lean-guard] Guard markers were removed. The file has been reverted. Do not modify the theorem signature.";
          return;
        }

        const endOfEndLine = content.indexOf("\n", endIdx);
        const protectedEnd = endOfEndLine === -1 ? content.length : endOfEndLine + 1;
        const currentProtected = content.slice(beginIdx, protectedEnd);

        if (currentProtected !== guard.protectedText) {
          resetFile(guard);
          const output = event.output as { output?: string };
          output.output = (output.output ?? "") +
            "\n[lean-guard] The theorem signature was modified. The file has been reverted. Only edit the proof body.";
        }
      }
    });
  },
});
