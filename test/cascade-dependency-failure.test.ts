/**
 * A task that can never complete must take its dependents with it, or the
 * run never finishes.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type DagTask } from "../src/engine.ts";

const fail = (taskId: string) => ({
  taskId,
  verifierAgent: "v",
  verifierModel: "m",
  timestamp: "t",
  status: "FAIL" as const,
  checks: [{ name: "c", type: "programmatic" as const, passed: false, cmd: "x", exitCode: 1 }],
  feedbackForWorker: "",
});
const pass = (taskId: string) => ({
  ...fail(taskId),
  status: "PASS" as const,
  checks: [{ name: "c", type: "programmatic" as const, passed: true, cmd: "x", exitCode: 0 }],
});

function engine(tasks: DagTask[]) {
  return Engine.create({
    runDir: join(mkdtempSync(join(tmpdir(), "cas-")), "r"),
    sessionId: "s",
    topology: "distributed-coding",
    tasks,
    budgetUsd: 100,
  });
}

describe("dead-lettering cascades to dependents", () => {
  test("a chain a -> b -> c all ends, and the run finishes", () => {
    const e = engine([
      { taskId: "a", title: "a", maxRounds: 1 },
      { taskId: "b", title: "b", dependsOn: ["a"] },
      { taskId: "c", title: "c", dependsOn: ["b"] },
    ]);
    e.dispatch("a");
    const out = e.recordRound({ taskId: "a", report: fail("a") });
    expect(out.status).toBe("DEADLETTER");
    expect(out.parkedDependents).toEqual(["b", "c"]);
    const s = e.status();
    expect(s.tasks.map((t) => t.status)).toEqual(["DEADLETTER", "DEADLETTER", "DEADLETTER"]);
    expect(s.state).toBe("DONE");
  });

  test("independent tasks are untouched and still run", () => {
    const e = engine([
      { taskId: "a", title: "a", maxRounds: 1 },
      { taskId: "b", title: "b", dependsOn: ["a"] },
      { taskId: "x", title: "x" },
    ]);
    e.dispatch("a");
    e.recordRound({ taskId: "a", report: fail("a") });
    expect(e.dispatchable(5).map((t) => t.taskId)).toEqual(["x"]);
    expect(e.status().state).toBe("RUNNING");
    e.dispatch("x");
    e.recordRound({ taskId: "x", report: pass("x") });
    expect(e.status().state).toBe("DONE");
  });

  test("a task with another, still-viable dependency is parked too", () => {
    // It needs both; one will never complete.
    const e = engine([
      { taskId: "a", title: "a", maxRounds: 1 },
      { taskId: "ok", title: "ok" },
      { taskId: "both", title: "both", dependsOn: ["a", "ok"] },
    ]);
    e.dispatch("a");
    expect(e.recordRound({ taskId: "a", report: fail("a") }).parkedDependents).toEqual(["both"]);
  });

  test("the reason names the dependency", () => {
    const e = engine([
      { taskId: "a", title: "a", maxRounds: 1 },
      { taskId: "b", title: "b", dependsOn: ["a"] },
    ]);
    e.dispatch("a");
    e.recordRound({ taskId: "a", report: fail("a") });
    const ev = e.events().find((x) => x.type === "task.deadletter" && x.taskId === "b")!;
    expect(ev.data).toMatchObject({ reason: "dependency a will not complete", dependency: "a" });
  });

  test("a failed round that will be retried parks nothing", () => {
    const e = engine([
      { taskId: "a", title: "a", maxRounds: 3 },
      { taskId: "b", title: "b", dependsOn: ["a"] },
    ]);
    e.dispatch("a");
    const out = e.recordRound({ taskId: "a", report: fail("a") });
    expect(out.status).toBe("PENDING");
    expect(out.parkedDependents).toBeUndefined();
    expect(e.status().tasks.find((t) => t.taskId === "b")!.status).toBe("PENDING");
  });
});
