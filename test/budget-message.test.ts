/**
 * The budget threshold warns; it does not halt. The message the sentinel
 * reads has to match what the engine does.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.ts";

function engineAt(costUsd: number) {
  const e = Engine.create({
    runDir: join(mkdtempSync(join(tmpdir(), "bud-")), "run"),
    sessionId: "b",
    topology: "small-focused",
    tasks: [
      { taskId: "t1", title: "one", maxRounds: 9 },
      { taskId: "t2", title: "two" },
    ],
    budgetUsd: 1,
  });
  e.recordRound({
    taskId: "t1",
    report: {
      taskId: "t1",
      verifierAgent: "v",
      verifierModel: "m",
      timestamp: new Date().toISOString(),
      status: "FAIL",
      checks: [{ name: "c", type: "programmatic", passed: false, cmd: "x", exitCode: 1 }],
      feedbackForWorker: "",
    },
    costUsd,
  });
  return e;
}

describe("haltAtPct", () => {
  test("crossing it warns but does not stop dispatch", () => {
    const e = engineAt(0.85); // 85% of a $1.00 cap, haltAtPct 80
    expect(e.haltAtPct).toBe(80);
    expect(e.status().pctOfBudget).toBeCloseTo(85, 5);
    expect(e.events().some((ev) => ev.type === "budget.warning")).toBe(true);
    expect(e.budgetExhausted()).toBe(false);
    expect(e.dispatchable(5).length).toBeGreaterThan(0);
  });

  test("the cap itself is what stops dispatch", () => {
    const e = engineAt(1.5);
    expect(e.budgetExhausted()).toBe(true);
    expect(e.dispatchable(5)).toEqual([]);
    expect(e.events().some((ev) => ev.type === "budget.exhausted")).toBe(true);
  });
});
