/**
 * Phase 1: one model in every seat.
 *
 * The load-bearing assertion is the last one — the emitted config patch must
 * contain no vendor model string anywhere. A single Anthropic/OpenAI/Google
 * default surviving into one of ten seats silently invalidates a single-model
 * baseline, and it is not visible by eye in a ten-role diff.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import {
  allSeatsAgents,
  billingFor,
  configuredModelRefs,
  describeWithOpencode,
  parseOpencodeModelsVerbose,
  findAlias,
  findConfiguredModels,
  findVendorModelStrings,
  protocolFor,
  resolveAlias,
  singleModelRouting,
  TEAM_ROLES as ROLES,
} from "../src/cli/all-seats.ts";
import { DEFAULT_POLICY } from "../src/policy.ts";

const MIMO = "xiaomi/mimo-v2.6-pro";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli", "index.ts");

/**
 * Drive the installer from source.
 *
 * Not from `dist/`: both CI and the `verify` script run `bun test` before
 * `bun run build`, so a dist-based test fails outright on a fresh clone and,
 * worse, passes against a stale artifact on a dirty one.
 */
function cli(args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** A config shaped like a real opencode provider block. */
function mimoConfig(npm = "@ai-sdk/openai-compatible"): Record<string, any> {
  return {
    provider: {
      xiaomi: {
        npm,
        options: { baseURL: "https://example.invalid/v1" },
        models: {
          "mimo-v2.6-pro": {
            name: "MiMo-V2.6-Pro",
            reasoning: true,
            tool_call: true,
            limit: { context: 1048576, output: 131072 },
            cost: { input: 0.435, output: 0.87 },
          },
        },
      },
    },
  };
}

describe("allSeatsAgents", () => {
  test("assigns the same model to every role the installer writes", () => {
    const agents = allSeatsAgents(ROLES, MIMO);
    expect(Object.keys(agents).length).toBe(ROLES.length);
    expect(Object.keys(agents).length).toBe(10);
    for (const role of ROLES) expect(agents[role]).toBe(MIMO);
  });

  test("covers the v2 DAG roles the documented example config omits", () => {
    const agents = allSeatsAgents(ROLES, MIMO);
    for (const role of ["team/proposer", "team/falsifier", "team/synthesizer", "team/scout"]) {
      expect(agents[role]).toBe(MIMO);
    }
  });

  test("writes the id verbatim — no normalising, no synthesising", () => {
    // Case matters: the id is lower-case, "MiMo-V2.6-Pro" is the display name.
    const agents = allSeatsAgents(ROLES, MIMO);
    expect(agents["team/worker"]).toBe("xiaomi/mimo-v2.6-pro");
    expect(allSeatsAgents(ROLES, "Weird/Mixed-Case_ID")["team/worker"]).toBe("Weird/Mixed-Case_ID");
  });

  test("rejects an empty or whitespace-bearing id", () => {
    expect(() => allSeatsAgents(ROLES, "")).toThrow(/needs a model id/);
    expect(() => allSeatsAgents(ROLES, "  ")).toThrow(/needs a model id/);
    expect(() => allSeatsAgents(ROLES, "xiaomi/mimo pro")).toThrow(/whitespace/);
  });
});

describe("findVendorModelStrings", () => {
  test("flags every vendor preset shipped upstream", () => {
    for (const vendor of [
      { "team/worker": { model: "anthropic/claude-sonnet-4-5" } },
      { "team/worker": { model: "openai/gpt-5-mini" } },
      { "team/worker": { model: "google/gemini-3-flash" } },
      { "team/worker": { model: "openrouter/meta-llama/llama-3.3-70b-instruct:free" } },
    ]) {
      expect(findVendorModelStrings(vendor, MIMO).length).toBeGreaterThan(0);
    }
  });

  test("reports the path, so a leak in one of ten seats is locatable", () => {
    const patch = {
      agent: {
        "team/worker": { model: MIMO },
        "team/scout": { model: "anthropic/claude-haiku-4-5" },
      },
    };
    const leaks = findVendorModelStrings(patch, MIMO);
    expect(leaks.length).toBe(1);
    expect(leaks[0]!.path).toBe("agent.team/scout.model");
    expect(leaks[0]!.value).toBe("anthropic/claude-haiku-4-5");
  });

  test("the pinned model itself is not a leak, case-insensitively", () => {
    expect(findVendorModelStrings({ model: MIMO }, MIMO)).toEqual([]);
    expect(findVendorModelStrings({ model: "XIAOMI/MIMO-V2.6-PRO" }, MIMO)).toEqual([]);
  });
});

describe("the emitted patch is vendor-free (the Phase 1 guarantee)", () => {
  test("allSeatsAgents output contains no vendor model string", () => {
    expect(findVendorModelStrings(allSeatsAgents(ROLES, MIMO), MIMO)).toEqual([]);
  });

  test("`install --print --all-seats <id>` emits no vendor model string", () => {
    // Drive the real CLI, so this covers buildPatch and the plugin entry too.
    const out = cli(["install", "--print", "--all-seats", MIMO]);

    const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
    const patch = JSON.parse(json);

    expect(Object.keys(patch.agent).length).toBe(10);
    for (const role of ROLES) expect(patch.agent[role].model).toBe(MIMO);

    // The whole emitted document, not just the models we happen to look at.
    expect(findVendorModelStrings(patch, MIMO)).toEqual([]);

    // And no vendor string anywhere in the printed output either.
    for (const s of ["anthropic/", "openai/", "google/", "claude-", "gpt-", "gemini-"]) {
      expect(out).not.toContain(s);
    }
    expect(out).toContain("No vendor model strings in the patch");
  });

  test("an upstream preset still fails the same check (the test can fail)", () => {
    const out = cli(["install", "--print", "--preset", "anthropic"]);
    const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
    expect(findVendorModelStrings(JSON.parse(json), MIMO).length).toBe(10);
  });
});

describe("mimo alias resolves from config, never from a hardcoded id", () => {
  test("no model id is hardcoded in the alias definition", () => {
    const alias = findAlias("mimo")!;
    expect(alias).toBeDefined();
    expect(JSON.stringify(alias)).not.toContain("mimo-v2.6");
    expect(JSON.stringify(alias)).not.toContain("2.6-pro");
  });

  test("resolves the id out of a provider block", () => {
    const r = resolveAlias(findAlias("mimo")!, mimoConfig(), "cfg.json");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.model.modelId).toBe(MIMO);
    expect(r.model.displayName).toBe("MiMo-V2.6-Pro");
    expect(r.model.reasoning).toBe(true);
  });

  test("reports the protocol from the provider's npm package", () => {
    const openai = resolveAlias(findAlias("mimo")!, mimoConfig("@ai-sdk/openai-compatible"), "c");
    const anthropic = resolveAlias(findAlias("mimo")!, mimoConfig("@ai-sdk/anthropic"), "c");
    expect(openai.ok && protocolFor(openai.model.npm)).toBe("openai");
    expect(anthropic.ok && protocolFor(anthropic.model.npm)).toBe("anthropic");
    expect(protocolFor(undefined)).toBe("unknown");
    expect(protocolFor("@some/unknown-sdk")).toBe("unknown");
  });

  test("refuses rather than guessing when the provider is absent", () => {
    const r = resolveAlias(findAlias("mimo")!, { provider: {} }, "cfg.json");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("found no matching model");
  });

  test("refuses rather than picking when several models match", () => {
    const cfg = mimoConfig();
    cfg.provider.xiaomi.models["mimo-v2.6-flash"] = { name: "MiMo-V2.6-Flash" };
    const r = resolveAlias(findAlias("mimo")!, cfg, "cfg.json");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("matched 2 models");
  });

  test("finds nothing in a config with no provider key at all", () => {
    expect(findConfiguredModels({}, /mimo/i)).toEqual([]);
    expect(findConfiguredModels({ provider: null }, /mimo/i)).toEqual([]);
  });
});

describe("singleModelRouting pins the upstream ladders", () => {
  test("every upstream ladder collapses to one rung", () => {
    const pinned = singleModelRouting(MIMO, DEFAULT_POLICY.routing);
    for (const [key, rule] of Object.entries(pinned)) {
      expect(rule.ladder).toEqual([MIMO]);
      expect(key).toBeTruthy();
    }
    expect(findVendorModelStrings(pinned, MIMO)).toEqual([]);
  });

  test("non-model fields of each rule are preserved", () => {
    const pinned = singleModelRouting(MIMO, DEFAULT_POLICY.routing);
    expect(pinned["taskClass:proof"]!.topology).toBe("long-proof");
    expect(pinned["taskClass:auth-change"]!.requiredChecks).toEqual([
      "adversarial:privilege-escalation",
    ]);
  });

  test("upstream's default routing really does carry vendor ids (baseline)", () => {
    expect(findVendorModelStrings(DEFAULT_POLICY.routing, MIMO).length).toBeGreaterThan(0);
  });
});

describe("loadPolicy honours the single-model pin", () => {
  test("pins ladders when the env var is set, leaves them alone otherwise", async () => {
    const { applySingleModelPin } = await import("../src/tools.ts");
    const dir = mkdtempSync(join(tmpdir(), "policy-"));
    writeFileSync(join(dir, "unused.json"), "{}");

    const before = process.env.TEAMWORK_ALL_SEATS_MODEL;
    try {
      delete process.env.TEAMWORK_ALL_SEATS_MODEL;
      expect(applySingleModelPin(DEFAULT_POLICY).routing["default"]!.ladder).toEqual([
        "anthropic/claude-sonnet-4-5",
      ]);

      process.env.TEAMWORK_ALL_SEATS_MODEL = MIMO;
      const pinned = applySingleModelPin(DEFAULT_POLICY);
      expect(findVendorModelStrings(pinned.routing, MIMO)).toEqual([]);
      for (const rule of Object.values(pinned.routing)) expect(rule.ladder).toEqual([MIMO]);
    } finally {
      if (before === undefined) delete process.env.TEAMWORK_ALL_SEATS_MODEL;
      else process.env.TEAMWORK_ALL_SEATS_MODEL = before;
    }
  });
});

describe("mimo alias with a catalog model (no provider block)", () => {
  test("resolves the model the config's default points at", () => {
    const cfg = { model: MIMO, agent: { build: { model: MIMO } } };
    const r = resolveAlias(findAlias("mimo")!, cfg, "cfg.json");
    expect(r.ok && r.model.modelId).toBe(MIMO);
  });

  test("refuses when the config uses two different matching models", () => {
    const cfg = { model: MIMO, small_model: "xiaomi/mimo-v2.5" };
    const r = resolveAlias(findAlias("mimo")!, cfg, "cfg.json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("uses 2 matching models");
  });

  test("configuredModelRefs collects default, small and agent models once each", () => {
    expect(
      configuredModelRefs({ model: "a/x", small_model: "a/y", agent: { p: { model: "a/x" }, q: { model: "b/z" } } }),
    ).toEqual(["a/x", "a/y", "b/z"]);
  });
});

describe("what opencode says about a model", () => {
  // Real output of `opencode models xiaomi --verbose` from opencode 1.18.32,
  // with its bundled catalog (which predates mimo-v2.6-pro).
  const fixture = readFileSync(
    new URL("./fixtures/opencode-1.18.32-models-xiaomi-verbose.txt", import.meta.url),
    "utf-8",
  );

  test("parses every model block", () => {
    const models = parseOpencodeModelsVerbose(fixture);
    expect(models.map((m) => m.id)).toEqual([
      "xiaomi/mimo-v2.5",
      "xiaomi/mimo-v2.5-pro",
      "xiaomi/mimo-v2.5-pro-ultraspeed",
    ]);
  });

  test("the built-in xiaomi provider speaks the OpenAI protocol, pay-as-you-go", () => {
    const pro = parseOpencodeModelsVerbose(fixture).find((m) => m.id === "xiaomi/mimo-v2.5-pro")!;
    expect(pro.npm).toBe("@ai-sdk/openai-compatible");
    expect(protocolFor(pro.npm)).toBe("openai");
    expect(pro.url).toBe("https://api.xiaomimimo.com/v1");
    expect(billingFor(pro.url)).toBe("pay-as-you-go");
    expect(pro.reasoning).toBe(true);
    expect(pro.interleavedField).toBe("reasoning_content");
  });

  test("Token Plan endpoints are told apart by host", () => {
    expect(billingFor("https://token-plan-sgp.xiaomimimo.com/v1")).toBe("token-plan");
    expect(billingFor("https://gateway.example.invalid/v1")).toBe("unknown");
    expect(billingFor(undefined)).toBe("unknown");
  });

  test("describeWithOpencode asks for the model's provider and picks the model", () => {
    const calls: string[][] = [];
    const info = describeWithOpencode("xiaomi/mimo-v2.5", (args) => {
      calls.push(args);
      return fixture;
    });
    expect(calls).toEqual([["models", "xiaomi", "--verbose"]]);
    expect(info?.id).toBe("xiaomi/mimo-v2.5");
  });

  test("returns null rather than guessing when opencode is unavailable or silent", () => {
    expect(describeWithOpencode(MIMO, () => null)).toBeNull();
    expect(describeWithOpencode(MIMO, () => fixture)).toBeNull(); // not in the bundled catalog
  });
});
