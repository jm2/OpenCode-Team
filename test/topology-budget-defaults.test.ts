/**
 * Each topology's defaultMaxCostUsd must actually apply when no budget is
 * given. The shipped policy's perSessionUsd of 20 was checked first, so every
 * run got $20 regardless of topology.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.ts";
import { TOPOLOGIES } from "../src/policy.ts";
import { loadPolicy } from "../src/tools.ts";

const engine = (topology: string, extra: Record<string, unknown> = {}) =>
  Engine.create({
    runDir: join(mkdtempSync(join(tmpdir(), "bud-")), "run"),
    sessionId: "s",
    topology,
    tasks: [{ taskId: "t", title: "t" }],
    ...extra,
  });

describe("budget precedence", () => {
  for (const t of TOPOLOGIES) {
    test(`${t.name} defaults to its own $${t.defaultMaxCostUsd}`, () => {
      expect(engine(t.name).budgetUsd).toBe(t.defaultMaxCostUsd);
    });
  }

  test("an explicit budget wins", () => {
    expect(engine("massive-proof-swarm", { budgetUsd: 1 }).budgetUsd).toBe(1);
  });

  test("a project policy that sets perSessionUsd applies to every topology", () => {
    const dir = mkdtempSync(join(tmpdir(), "pol-"));
    mkdirSync(join(dir, ".teamwork"));
    writeFileSync(join(dir, ".teamwork", "policy.json"), '{"budget":{"perSessionUsd":7}}');
    const policy = loadPolicy(dir);
    expect(engine("small-focused", { policy }).budgetUsd).toBe(7);
    expect(engine("massive-proof-swarm", { policy }).budgetUsd).toBe(7);
  });

  test("a project policy that leaves perSessionUsd unset keeps topology defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "pol-"));
    mkdirSync(join(dir, ".teamwork"));
    writeFileSync(join(dir, ".teamwork", "policy.json"), '{"budget":{"perTaskUsd":1}}');
    expect(engine("long-proof", { policy: loadPolicy(dir) }).budgetUsd).toBe(40);
  });

  test("the chosen budget survives resume", () => {
    const e = engine("document-review");
    expect(Engine.resume(e.runDir).budgetUsd).toBe(12);
  });
});
