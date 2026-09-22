/**
 * A policy file that exists but will not parse must not fail silently.
 *
 * The silent fallback discarded everything the file said — ladders, budget,
 * and any requiredChecks the project added — with no signal.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY } from "../src/policy.ts";
import { loadPolicy, loadPolicyResult } from "../src/tools.ts";

function projectWith(policyJson?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pol-"));
  if (policyJson !== undefined) {
    mkdirSync(join(dir, ".teamwork"), { recursive: true });
    writeFileSync(join(dir, ".teamwork", "policy.json"), policyJson, "utf-8");
  }
  return dir;
}

describe("loadPolicyResult", () => {
  test("no policy file is not an error", () => {
    const r = loadPolicyResult(projectWith());
    expect(r.error).toBeUndefined();
    expect(r.policy).toEqual(DEFAULT_POLICY);
  });

  test("a valid policy file is merged over the defaults", () => {
    const r = loadPolicyResult(projectWith('{"budget":{"perSessionUsd":5}}'));
    expect(r.error).toBeUndefined();
    expect(r.policy.budget.perSessionUsd).toBe(5);
    expect(r.policy.budget.haltAtPct).toBe(DEFAULT_POLICY.budget.haltAtPct);
  });

  test("a malformed policy file reports the reason and the path", () => {
    const dir = projectWith('{ "budget": { "perSessionUsd": 5 },, }');
    const r = loadPolicyResult(dir);
    expect(r.error).toBeTruthy();
    expect(r.path).toContain("policy.json");
    // Still usable: the run falls back rather than dying.
    expect(r.policy).toEqual(DEFAULT_POLICY);
  });

  test("the silently-wrong value is what this catches", () => {
    // The old behaviour: ask for 5, silently get the default, hear nothing.
    const dir = projectWith('{ "budget": { "perSessionUsd": 5 },, }');
    expect(loadPolicy(dir).budget.perSessionUsd).not.toBe(5);
    expect(loadPolicy(dir).budget.perSessionUsd).toBe(DEFAULT_POLICY.budget.perSessionUsd);
    expect(loadPolicyResult(dir).error).toBeTruthy();
  });

  test("a project's own requiredChecks are what the fallback loses", () => {
    const declared =
      '"routing":{"taskClass:payments":{"ladder":["x"],"requiredChecks":["adversarial:double-spend"]}}';
    const good = loadPolicyResult(projectWith(`{${declared}}`));
    expect(good.policy.routing["taskClass:payments"]!.requiredChecks).toEqual(["adversarial:double-spend"]);

    // Same file with a trailing comma: the project's check is gone.
    const bad = loadPolicyResult(projectWith(`{${declared},}`));
    expect(bad.error).toBeTruthy();
    expect(bad.policy.routing["taskClass:payments"]).toBeUndefined();
  });

  test("the checks shipped in the defaults survive the fallback", () => {
    // Stated plainly so nobody overclaims what the silent fallback removed.
    const bad = loadPolicyResult(projectWith("{,}"));
    expect(bad.policy.routing["taskClass:auth-change"]!.requiredChecks).toEqual([
      "adversarial:privilege-escalation",
    ]);
  });

  test("loadPolicy keeps its signature for existing callers", () => {
    expect(loadPolicy(projectWith('{"budget":{"perTaskUsd":9}}')).budget.perTaskUsd).toBe(9);
  });
});
