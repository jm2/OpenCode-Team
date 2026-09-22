/**
 * `--plugin` lets the installer point opencode at a local build, and every
 * installer path recognises such an entry as this plugin.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isTeamworkEntry, resolvePluginArg } from "../src/cli/plugin-spec.ts";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

/** A throwaway checkout: package.json naming this package plus a built entry. */
function fakeCheckout(name = "opencode-teamwork", built = true): string {
  const root = mkdtempSync(join(tmpdir(), "checkout-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name }));
  if (built) {
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "index.js"), "export default async () => ({});\n");
  }
  return root;
}

const run = (args: string[]) =>
  execFileSync(process.execPath, [CLI, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

describe("resolvePluginArg", () => {
  test("a checkout directory becomes a file URL to its build", () => {
    const root = fakeCheckout();
    const r = resolvePluginArg(root, "/nowhere");
    expect(r).toEqual({ ok: true, spec: pathToFileURL(join(root, "dist", "index.js")).href, local: true });
  });

  test("an unbuilt checkout is refused with the fix", () => {
    const root = fakeCheckout("opencode-teamwork", false);
    const r = resolvePluginArg(root, "/nowhere");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("bun run build");
  });

  test("local resolves from the CLI's own location", () => {
    const root = fakeCheckout();
    const r = resolvePluginArg("local", join(root, "dist", "cli"));
    expect(r.ok && r.spec).toBe(pathToFileURL(join(root, "dist", "index.js")).href);
  });

  test("a missing path or file URL is refused", () => {
    expect(resolvePluginArg("/does/not/exist", "/").ok).toBe(false);
    expect(resolvePluginArg("file:///does/not/exist.js", "/").ok).toBe(false);
  });

  test("anything else passes through as an npm spec", () => {
    expect(resolvePluginArg("opencode-teamwork@0.3.0", "/")).toEqual({
      ok: true,
      spec: "opencode-teamwork@0.3.0",
      local: false,
    });
  });
});

describe("isTeamworkEntry", () => {
  test("npm specs of this package, not similar names", () => {
    expect(isTeamworkEntry("opencode-teamwork")).toBe(true);
    expect(isTeamworkEntry("opencode-teamwork@latest")).toBe(true);
    expect(isTeamworkEntry("opencode-teamwork-extras")).toBe(false);
  });

  test("file URLs into a build of this package, not of another", () => {
    const mine = fakeCheckout();
    const other = fakeCheckout("some-other-plugin");
    expect(isTeamworkEntry(pathToFileURL(join(mine, "dist", "index.js")).href)).toBe(true);
    expect(isTeamworkEntry(pathToFileURL(join(other, "dist", "index.js")).href)).toBe(false);
  });
});

describe("the installer with --plugin", () => {
  test("writes the local build and replaces an earlier npm entry", () => {
    const root = fakeCheckout();
    const cfg = join(mkdtempSync(join(tmpdir(), "cfg-")), "opencode.json");
    writeFileSync(cfg, JSON.stringify({ plugin: ["opencode-wakatime", "opencode-teamwork@latest"] }));
    run(["install", "--preset", "google", "--yes", "--plugin", root, "--config", cfg]);
    expect(JSON.parse(readFileSync(cfg, "utf-8")).plugin).toEqual([
      "opencode-wakatime",
      pathToFileURL(join(root, "dist", "index.js")).href,
    ]);
  });

  test("uninstall removes a local-build entry", () => {
    const root = fakeCheckout();
    const url = pathToFileURL(join(root, "dist", "index.js")).href;
    const cfg = join(mkdtempSync(join(tmpdir(), "cfg-")), "opencode.json");
    writeFileSync(cfg, JSON.stringify({ plugin: ["opencode-wakatime", url] }));
    run(["uninstall", "--yes", "--config", cfg]);
    expect(JSON.parse(readFileSync(cfg, "utf-8")).plugin).toEqual(["opencode-wakatime"]);
  });

  test("a bad --plugin value fails before touching the config", () => {
    const cfg = join(mkdtempSync(join(tmpdir(), "cfg-")), "opencode.json");
    writeFileSync(cfg, '{"plugin":["x"]}');
    expect(() => run(["install", "--preset", "google", "--yes", "--plugin", "/nope", "--config", cfg])).toThrow();
    expect(readFileSync(cfg, "utf-8")).toBe('{"plugin":["x"]}');
  });
});
