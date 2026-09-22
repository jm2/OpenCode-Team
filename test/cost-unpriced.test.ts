/**
 * An unknown model must not be priced from another vendor's rate card.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCostTracker } from "../src/cost.ts";

const dir = () => mkdtempSync(join(tmpdir(), "cost-"));
const entry = (model: string) => ({
  agentName: "team/worker",
  model,
  taskId: "t1",
  tokensUsed: { input: 1_000_000, output: 1_000_000 },
  wallClockSeconds: 1,
  toolCalls: 0,
});

describe("unknown models", () => {
  test("are not billed at the Claude Sonnet rate", () => {
    const t = createCostTracker("s", dir(), { maxBudget: 100 });
    // The old fallback charged 0.003/0.015 per 1k => $18.00 for 1M + 1M.
    expect(t.record(entry("some-provider/some-model")).costUsd).toBe(0);
  });

  test("are reported rather than hidden", () => {
    const t = createCostTracker("s", dir(), { maxBudget: 100 });
    t.record(entry("some-provider/some-model"));
    t.record(entry("anthropic/claude-sonnet-4-5"));
    expect(t.unpriced()).toEqual(["some-provider/some-model"]);
  });

  test("a custom rate makes them priced", () => {
    const t = createCostTracker("s", dir(), {
      maxBudget: 100,
      customRates: { "some-provider/some-model": { input: 0.000435, output: 0.00087 } },
    });
    expect(t.record(entry("some-provider/some-model")).costUsd).toBeCloseTo(1.305, 5);
    expect(t.unpriced()).toEqual([]);
  });

  test("known models are unaffected", () => {
    const t = createCostTracker("s", dir(), { maxBudget: 100 });
    expect(t.record(entry("anthropic/claude-sonnet-4-5")).costUsd).toBeCloseTo(18, 5);
    expect(t.record(entry("google/gemini-3-flash")).costUsd).toBeCloseTo(0.375, 5);
  });

  test("totals still persist to costs.json", () => {
    const d = dir();
    const t = createCostTracker("s", d, { maxBudget: 100 });
    t.record(entry("anthropic/claude-haiku-4-5"));
    t.flush();
    const saved = JSON.parse(readFileSync(join(d, "costs.json"), "utf-8"));
    expect(saved.totals.costUsd).toBeCloseTo(4.8, 5);
  });
});
