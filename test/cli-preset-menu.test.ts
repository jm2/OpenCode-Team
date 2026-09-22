/**
 * The non-interactive halves of the preset picker fix.
 *
 * The menu itself needs a terminal, so it is covered by the pty check in the
 * commit message rather than here; what is asserted below is everything the
 * CLI does without one.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli", "index.ts");

/**
 * Drive the installer from source rather than from `dist/`.
 *
 * CI and the verify script both run `bun test` before `bun run build`, so a
 * dist-based test fails on a fresh clone and passes against a stale artifact
 * on a dirty one.
 */
function cli(args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { out, code: 0 };
  } catch (e: any) {
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
  }
}

describe("--preset custom", () => {
  test("is no longer rejected as an unknown preset", () => {
    // It used to fall through to "Unknown preset: custom" despite being
    // documented in SKILL.md.
    const { out } = cli(["install", "--print", "--preset", "custom"]);
    expect(out).not.toContain("Unknown preset");
  });

  test("explains that it needs a terminal, and exits non-zero", () => {
    const { out, code } = cli(["install", "--print", "--preset", "custom"]);
    expect(out).toContain("needs an interactive terminal");
    expect(code).toBe(1);
  });
});

describe("preset errors", () => {
  test("an unknown preset still fails and now lists custom", () => {
    const { out, code } = cli(["install", "--print", "--preset", "nope"]);
    expect(code).toBe(1);
    expect(out).toContain("Unknown preset: nope");
    expect(out).toContain("custom");
  });

  test("a real preset still works untouched", () => {
    const { out, code } = cli(["install", "--print", "--preset", "google"]);
    expect(code).toBe(0);
    expect(out).toContain("google/gemini-3.1-pro");
  });

  test("--help documents custom without overstating it", () => {
    const { out } = cli(["--help"]);
    expect(out).toContain("custom");
    expect(out).toContain("needs a terminal");
  });
});
