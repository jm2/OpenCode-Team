/**
 * Two-model teams: --strong / --fast, --seat overrides, and the run-time
 * check that every seat ran on the model configured for it.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findVendorModelStrings,
  parseOpencodeModelsVerbose,
  parseSeatOverrides,
  SEAT_TIERS,
  TEAM_ROLES,
  tieredAgents,
} from "../src/cli/all-seats.ts";
import { recordSeatModels, seatModel } from "../src/seat-models.ts";
import { summarize, seatMismatches, UsageObserver } from "../src/telemetry.ts";
import { usageReport } from "../src/tools.ts";

const PRO = "xiaomi/mimo-v2.6-pro";
const FLASH = "deepseek/deepseek-flash";
const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

describe("tieredAgents", () => {
  test("every seat gets its tier's model", () => {
    const agents = tieredAgents(TEAM_ROLES, PRO, FLASH);
    expect(Object.keys(agents).length).toBe(10);
    for (const role of TEAM_ROLES) {
      expect(agents[role]).toBe(SEAT_TIERS[role].tier === "strong" ? PRO : FLASH);
    }
  });

  test("Flash goes only where a weak answer is cheap or caught by code", () => {
    const fast = TEAM_ROLES.filter((r) => SEAT_TIERS[r].tier === "fast");
    expect(fast).toEqual(["team/verifier", "team/proposer", "team/scout"]);
  });

  test("--seat overrides one seat, in short or full form", () => {
    const o = parseSeatOverrides(["--seat", "worker=" + FLASH, "--seat=team/scout=" + PRO]);
    expect(o).toEqual({ "team/worker": FLASH, "team/scout": PRO });
    const agents = tieredAgents(TEAM_ROLES, PRO, FLASH, o);
    expect(agents["team/worker"]).toBe(FLASH);
    expect(agents["team/scout"]).toBe(PRO);
    expect(agents["team/sentinel"]).toBe(PRO);
  });

  test("bad overrides are refused", () => {
    expect(() => parseSeatOverrides(["--seat", "janitor=x/y"])).toThrow(/unknown role/);
    expect(() => parseSeatOverrides(["--seat", "worker"])).toThrow(/<role>=<model>/);
    expect(() => tieredAgents(TEAM_ROLES, "", FLASH)).toThrow(/--strong/);
  });

  test("the purity check accepts exactly the chosen models", () => {
    const patch = { agent: Object.fromEntries(Object.entries(tieredAgents(TEAM_ROLES, PRO, FLASH)).map(([k, v]) => [k, { model: v }])) };
    expect(findVendorModelStrings(patch, [PRO, FLASH])).toEqual([]);
    // deepseek/ is a vendor prefix: allowing only Pro flags the Flash seats.
    expect(findVendorModelStrings(patch, [PRO]).length).toBe(3);
  });
});

describe("the installer", () => {
  const run = (args: string[]) =>
    execFileSync(process.execPath, [CLI, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: "/usr/bin:/bin" } });

  test("--strong/--fast writes a two-model team and nothing else", () => {
    const out = run(["install", "--print", "--strong", PRO, "--fast", FLASH]);
    const patch = JSON.parse(out.slice(out.indexOf("{\n"), out.lastIndexOf("}") + 1));
    const models = new Set(Object.values(patch.agent).map((a: any) => a.model));
    expect([...models].sort()).toEqual([FLASH, PRO].sort());
    expect(patch.agent["team/worker"].model).toBe(PRO);
    expect(patch.agent["team/verifier"].model).toBe(FLASH);
    expect(out).toContain('on "xiaomi/mimo-v2.6-pro" and "deepseek/deepseek-flash" only');
  });

  test("--strong without --fast is refused", () => {
    expect(() => run(["install", "--print", "--strong", PRO])).toThrow();
  });

  test("--seat also works on top of --all-seats", () => {
    const out = run(["install", "--print", "--all-seats", PRO, "--seat", "scout=" + FLASH]);
    const patch = JSON.parse(out.slice(out.indexOf("{\n"), out.lastIndexOf("}") + 1));
    expect(patch.agent["team/scout"].model).toBe(FLASH);
    expect(patch.agent["team/worker"].model).toBe(PRO);
  });
});

describe("what opencode reports for DeepSeek V4.1 Flash", () => {
  test("the bundled catalog's id, protocol and price", () => {
    const text = readFileSync(new URL("./fixtures/opencode-1.18.32-models-deepseek-verbose.txt", import.meta.url), "utf-8");
    const flash = parseOpencodeModelsVerbose(text).find((m) => m.id === FLASH)!;
    expect(flash.name).toBe("DeepSeek V4.1 Flash");
    expect(flash.npm).toBe("@ai-sdk/openai-compatible");
    expect(flash.url).toBe("https://api.deepseek.com");
    expect(flash.cost).toEqual({ input: 0.15, output: 0.6 });
    expect(flash.interleavedField).toBe("reasoning_content");
  });
});

describe("at run time", () => {
  const msg = (id: string, mode: string, provider: string, model: string) => ({
    type: "message.updated",
    properties: {
      info: {
        id, role: "assistant", sessionID: "root", mode, providerID: provider, modelID: model,
        time: { created: 1, completed: 2 }, cost: 0.001,
        tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 0, write: 0 } },
      },
    },
  });

  test("the plugin remembers each seat's configured model", () => {
    recordSeatModels({ "team/worker": { model: PRO }, "team/scout": { model: FLASH }, build: { model: "x/y" } });
    expect(seatModel("team/worker")).toBe(PRO);
    expect(seatModel("build")).toBeUndefined();
    recordSeatModels({}); // module state: leave nothing behind for other tests
  });

  test("a seat on a model other than its configured one is reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "mix-"));
    const o = new UsageObserver({ runDirFor: () => dir });
    o.onEvent(msg("m1", "team/sentinel", "xiaomi", "mimo-v2.6-pro"));
    o.onEvent(msg("m2", "team/verifier", "deepseek", "deepseek-flash"));
    o.onEvent(msg("m3", "team/worker", "deepseek", "deepseek-flash"));
    const expected = { "team/sentinel": PRO, "team/verifier": FLASH, "team/worker": PRO };
    const report = usageReport(dir, undefined, expected).join("\n");
    expect(report).toContain("SEAT MISMATCH: team/worker ran on deepseek/deepseek-flash, configured xiaomi/mimo-v2.6-pro");
    expect(report).toContain("spend by model:");
  });

  test("a correct split reports clean", () => {
    const dir = mkdtempSync(join(tmpdir(), "mix-"));
    const o = new UsageObserver({ runDirFor: () => dir });
    o.onEvent(msg("n1", "team/sentinel", "xiaomi", "mimo-v2.6-pro"));
    o.onEvent(msg("n2", "team/verifier", "deepseek", "deepseek-flash"));
    const expected = { "team/sentinel": PRO, "team/verifier": FLASH };
    expect(usageReport(dir, undefined, expected).join("\n")).toContain("every seat that ran used its configured model");
  });

  test("seatMismatches ignores agents with no configured seat", () => {
    const s = summarize([]);
    s.byAgent["general"] = { messages: 1, costUsd: 0, withReasoning: 0, reasoningTokens: 0, models: ["a/b"] };
    expect(seatMismatches(s, { "team/worker": PRO })).toEqual([]);
  });
});
