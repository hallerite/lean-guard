import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";

// ── Core logic extracted from plugin for testing ────────────────────────────

const BEGIN_MARKER = "-- lean-guard: begin protected";
const END_MARKER = "-- lean-guard: end protected";

interface GuardInfo {
  filePath: string;
  protectedText: string;
}

function parseGuardedFile(filePath: string): GuardInfo | null {
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

/** Simulate the after-hook: returns true if protected region is intact. */
function checkIntegrity(guard: GuardInfo): boolean {
  const content = readFileSync(guard.filePath, "utf-8");
  const beginIdx = content.indexOf(BEGIN_MARKER);
  const endIdx = content.indexOf(END_MARKER);
  if (beginIdx === -1 || endIdx === -1) return false;
  const endOfEndLine = content.indexOf("\n", endIdx);
  const protectedEnd = endOfEndLine === -1 ? content.length : endOfEndLine + 1;
  return content.slice(beginIdx, protectedEnd) === guard.protectedText;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const PROOF_FILE_CONTENT = `import Mathlib

${BEGIN_MARKER}
theorem foo (n : Nat) : n + 0 = n := by
${END_MARKER}
  sorry
`;

let tmpDir: string;
let proofFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync("/tmp/lean-guard-test-");
  proofFile = join(tmpDir, "proof.lean");
  writeFileSync(proofFile, PROOF_FILE_CONTENT);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("parseGuardedFile", () => {
  test("extracts protected region containing only the signature", () => {
    const guard = parseGuardedFile(proofFile)!;
    expect(guard).not.toBeNull();
    expect(guard.protectedText).toContain("theorem foo");
    expect(guard.protectedText).toContain(BEGIN_MARKER);
    expect(guard.protectedText).toContain(END_MARKER);
    // Imports must NOT be in protected region
    expect(guard.protectedText).not.toContain("import Mathlib");
  });

  test("returns null for file without markers", () => {
    const plain = join(tmpDir, "plain.lean");
    writeFileSync(plain, "theorem bar : True := by trivial\n");
    expect(parseGuardedFile(plain)).toBeNull();
  });
});

describe("after hook: legitimate edits pass", () => {
  test("replacing sorry with a proof", () => {
    const guard = parseGuardedFile(proofFile)!;
    const content = readFileSync(proofFile, "utf-8");
    writeFileSync(proofFile, content.replace("  sorry\n", "  simp [Nat.add_zero]\n"));
    expect(checkIntegrity(guard)).toBe(true);
  });

  test("adding imports above markers", () => {
    const guard = parseGuardedFile(proofFile)!;
    const content = readFileSync(proofFile, "utf-8");
    writeFileSync(proofFile, content.replace("import Mathlib", "import Mathlib\nimport Mathlib.Tactic"));
    expect(checkIntegrity(guard)).toBe(true);
  });

  test("adding a helper lemma between imports and markers", () => {
    const guard = parseGuardedFile(proofFile)!;
    const content = readFileSync(proofFile, "utf-8");
    const helper = "lemma helper : True := trivial\n\n";
    writeFileSync(proofFile, content.replace(BEGIN_MARKER, helper + BEGIN_MARKER));
    expect(checkIntegrity(guard)).toBe(true);
  });

  test("overlapping edit that includes signature context but doesn't change it", () => {
    // Agent does: old="n := by\n-- lean-guard: end protected\n  sorry"
    //             new="n := by\n-- lean-guard: end protected\n  simp"
    const guard = parseGuardedFile(proofFile)!;
    const content = readFileSync(proofFile, "utf-8");
    // This edit spans from inside the protected region into the proof body,
    // but the protected part is unchanged — after-hook should pass.
    writeFileSync(proofFile, content.replace("  sorry", "  simp"));
    expect(checkIntegrity(guard)).toBe(true);
  });
});

describe("after hook: tampering detected", () => {
  test("changing theorem name", () => {
    const guard = parseGuardedFile(proofFile)!;
    const content = readFileSync(proofFile, "utf-8");
    writeFileSync(proofFile, content.replace("theorem foo", "theorem bar"));
    expect(checkIntegrity(guard)).toBe(false);
  });

  test("weakening the goal", () => {
    const guard = parseGuardedFile(proofFile)!;
    const content = readFileSync(proofFile, "utf-8");
    writeFileSync(proofFile, content.replace("n + 0 = n", "True"));
    expect(checkIntegrity(guard)).toBe(false);
  });

  test("removing begin marker", () => {
    const guard = parseGuardedFile(proofFile)!;
    const content = readFileSync(proofFile, "utf-8");
    writeFileSync(proofFile, content.replace(BEGIN_MARKER + "\n", ""));
    expect(checkIntegrity(guard)).toBe(false);
  });

  test("removing end marker", () => {
    const guard = parseGuardedFile(proofFile)!;
    const content = readFileSync(proofFile, "utf-8");
    writeFileSync(proofFile, content.replace(END_MARKER + "\n", ""));
    expect(checkIntegrity(guard)).toBe(false);
  });

  test("removing both markers", () => {
    const guard = parseGuardedFile(proofFile)!;
    const content = readFileSync(proofFile, "utf-8");
    writeFileSync(proofFile, content
      .replace(BEGIN_MARKER + "\n", "")
      .replace(END_MARKER + "\n", ""));
    expect(checkIntegrity(guard)).toBe(false);
  });

  test("changing hypotheses", () => {
    const guard = parseGuardedFile(proofFile)!;
    const content = readFileSync(proofFile, "utf-8");
    writeFileSync(proofFile, content.replace("(n : Nat)", "(n : Nat) (h : n = 0)"));
    expect(checkIntegrity(guard)).toBe(false);
  });
});

describe("after hook: reset restores safe state", () => {
  test("reset produces valid file with sorry", () => {
    const guard = parseGuardedFile(proofFile)!;
    // Simulate reset
    writeFileSync(proofFile, guard.protectedText + "  sorry\n");

    const restored = readFileSync(proofFile, "utf-8");
    expect(restored).toContain(BEGIN_MARKER);
    expect(restored).toContain(END_MARKER);
    expect(restored).toContain("theorem foo");
    expect(restored.trim().endsWith("sorry")).toBe(true);
    // And integrity check passes on the reset file
    expect(checkIntegrity(guard)).toBe(true);
  });
});

describe("bash before hook: shell write detection", () => {
  test("blocks redirect", () => {
    expect(isShellWriteToFile(`echo x > ${proofFile}`, proofFile)).toBe(true);
  });

  test("blocks sed -i", () => {
    expect(isShellWriteToFile(`sed -i 's/sorry/trivial/' ${proofFile}`, proofFile)).toBe(true);
  });

  test("blocks tee", () => {
    expect(isShellWriteToFile(`echo x | tee ${proofFile}`, proofFile)).toBe(true);
  });

  test("blocks cp", () => {
    expect(isShellWriteToFile(`cp /tmp/x ${proofFile}`, proofFile)).toBe(true);
  });

  test("blocks mv", () => {
    expect(isShellWriteToFile(`mv /tmp/x ${proofFile}`, proofFile)).toBe(true);
  });

  test("allows cat (read)", () => {
    expect(isShellWriteToFile(`cat ${proofFile}`, proofFile)).toBe(false);
  });

  test("allows lake compile", () => {
    expect(isShellWriteToFile(`lake env lean ${proofFile}`, proofFile)).toBe(false);
  });

  test("allows grep", () => {
    expect(isShellWriteToFile(`grep sorry ${proofFile}`, proofFile)).toBe(false);
  });
});
