/**
 * Installing and uninstalling must not destroy unrelated configuration.
 * Driven through the real CLI, from source.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

function withConfig(config: Record<string, unknown>): string {
  const path = join(mkdtempSync(join(tmpdir(), "cfg-")), "opencode.json");
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
  return path;
}

function run(args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

const read = (path: string) => JSON.parse(readFileSync(path, "utf-8"));

const FULL = {
  $schema: "https://opencode.ai/config.json",
  model: "xiaomi/mimo-v2.6-pro",
  provider: { xiaomi: { npm: "@ai-sdk/openai-compatible", models: { "mimo-v2.6-pro": {} } } },
  mcp: { github: { type: "remote", url: "https://example.invalid/mcp" } },
  plugin: ["opencode-wakatime", "@acme/opencode-guardrails"],
  agent: { build: { model: "xiaomi/mimo-v2.6-pro" } },
};

describe("install", () => {
  test("keeps the user's other plugins", () => {
    const path = withConfig(FULL);
    run(["install", "--preset", "google", "--yes", "--config", path]);
    const plugins = read(path).plugin;
    expect(plugins.slice(0, 2)).toEqual(["opencode-wakatime", "@acme/opencode-guardrails"]);
    expect(plugins[2]).toMatch(/^opencode-teamwork@/);
    expect(plugins.length).toBe(3);
  });

  test("replaces an earlier spec of this package instead of loading two", () => {
    const path = withConfig({ plugin: ["opencode-wakatime", "opencode-teamwork@0.2.1"] });
    run(["install", "--preset", "google", "--yes", "--config", path]);
    const plugins = read(path).plugin;
    expect(plugins[0]).toBe("opencode-wakatime");
    expect(plugins[1]).toMatch(/^opencode-teamwork@/);
    expect(plugins[1]).not.toBe("opencode-teamwork@0.2.1");
    expect(plugins.length).toBe(2);
  });

  test("does not mistake a similarly named package for this one", () => {
    const path = withConfig({ plugin: ["opencode-teamwork-extras"] });
    run(["install", "--preset", "google", "--yes", "--config", path]);
    const plugins = read(path).plugin;
    expect(plugins[0]).toBe("opencode-teamwork-extras");
    expect(plugins[1]).toMatch(/^opencode-teamwork@/);
  });

  test("keeps every unrelated key", () => {
    const path = withConfig(FULL);
    run(["install", "--preset", "google", "--yes", "--config", path]);
    const after = read(path);
    for (const k of ["$schema", "model", "provider", "mcp"]) expect(after[k]).toEqual((FULL as any)[k]);
    expect(after.agent.build).toEqual(FULL.agent.build);
  });

  test("the preview shows the changes it is about to make", () => {
    // It diffed the merged config against itself and always said "(no changes)".
    const path = withConfig(FULL);
    const out = run(["install", "--preset", "google", "--yes", "--config", path]);
    const preview = out.slice(out.indexOf("Changes that will be made"));
    expect(preview).not.toContain("(no changes)");
    expect(preview).toContain("plugin");
    expect(preview).toContain("agent");
  });
});

describe("uninstall", () => {
  test("keeps providers, MCP servers, the model and $schema", () => {
    const path = withConfig({
      ...FULL,
      plugin: [...FULL.plugin, "opencode-teamwork@latest"],
      agent: { ...FULL.agent, "team/worker": { model: "x/y" } },
    });
    run(["uninstall", "--yes", "--config", path]);
    const after = read(path);
    for (const k of ["$schema", "model", "provider", "mcp"]) expect(after[k]).toEqual((FULL as any)[k]);
    expect(after.plugin).toEqual(FULL.plugin);
    expect(after.agent).toEqual({ build: FULL.agent.build });
  });

  test("leaves a similarly named package installed", () => {
    const path = withConfig({ plugin: ["opencode-teamwork-extras", "opencode-teamwork@latest"] });
    run(["uninstall", "--yes", "--config", path]);
    expect(read(path).plugin).toEqual(["opencode-teamwork-extras"]);
  });
});
