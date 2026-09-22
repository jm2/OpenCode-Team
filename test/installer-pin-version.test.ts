/**
 * The installer must wire in the plugin version that matches the CLI.
 * "@latest" silently installed npm's 0.2.1 from a 0.3.0 CLI.
 */

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).version as string;

test("the plugin spec is pinned to this CLI's version", () => {
  const out = execFileSync(
    process.execPath,
    [join(ROOT, "src", "cli", "index.ts"), "install", "--print", "--preset", "google"],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const patch = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
  expect(patch.plugin).toEqual([`opencode-teamwork@${version}`]);
  expect(out).not.toContain("opencode-teamwork@latest");
});
