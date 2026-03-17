import { readFileSync, writeFileSync, existsSync } from "fs";
import type { Plugin } from "@opencode-ai/plugin";

const BEGIN_MARKER = "-- lean-guard: begin protected";
const END_MARKER = "-- lean-guard: end protected";

const PROOF_FILE = process.env.LEAN_GUARD_FILE ?? "";

interface GuardInfo {
  filePath: string;
  protectedText: string;
}

let guard: GuardInfo | null = null;

function parseGuardedFile(filePath: string): GuardInfo | null {
  if (!filePath || !existsSync(filePath)) return null;

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

function resetFile(g: GuardInfo): void {
  writeFileSync(g.filePath, g.protectedText + "  sorry\n", "utf-8");
}

export const LeanGuard: Plugin = async ({ $ }) => {
  // Parse the proof file eagerly at init
  guard = parseGuardedFile(PROOF_FILE);
  if (!guard) {
    console.error(
      `[lean-guard] ${PROOF_FILE ? `No guard markers in ${PROOF_FILE}` : "LEAN_GUARD_FILE not set"}, plugin disabled.`
    );
    return {};
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (!guard) return;

      // Block bash commands that write to the proof file
      if (input.tool === "bash") {
        const command = (output.args?.command ?? "") as string;
        if (isShellWriteToFile(command, guard.filePath)) {
          throw new Error(
            "[lean-guard] Cannot write to the proof file via shell. Use 'edit' to modify only the proof body."
          );
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      if (!guard) return;
      if (!["edit", "bash"].includes(input.tool)) return;
      if (!existsSync(guard.filePath)) return;

      const content = readFileSync(guard.filePath, "utf-8");
      const beginIdx = content.indexOf(BEGIN_MARKER);
      const endIdx = content.indexOf(END_MARKER);

      if (beginIdx === -1 || endIdx === -1) {
        resetFile(guard);
        throw new Error(
          "[lean-guard] Guard markers were removed. The file has been reverted. Do not modify the theorem signature."
        );
      }

      const endOfEndLine = content.indexOf("\n", endIdx);
      const protectedEnd = endOfEndLine === -1 ? content.length : endOfEndLine + 1;
      const currentProtected = content.slice(beginIdx, protectedEnd);

      if (currentProtected !== guard.protectedText) {
        resetFile(guard);
        throw new Error(
          "[lean-guard] The theorem signature was modified. The file has been reverted. Only edit the proof body."
        );
      }
    },
  };
};
