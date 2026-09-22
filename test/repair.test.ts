/**
 * Phase 2: bounded repair at the model-authored artifact boundary.
 *
 * The invariants under test, in priority order:
 *   1. a malformed artifact is never coerced or fabricated into a valid one;
 *   2. the loop is bounded in code, not by the model's patience;
 *   3. the raw output survives to disk on every attempt, including the last.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { VerificationReportSchema } from "../src/artifacts.ts";
import {
  DEFAULT_MAX_REPAIRS,
  describeSchema,
  readLedger,
  repairArtifact,
} from "../src/repair.ts";

function runDir(): string {
  return mkdtempSync(join(tmpdir(), "repair-"));
}

const GOOD = {
  taskId: "t1",
  verifierAgent: "team/verifier",
  verifierModel: "xiaomi/mimo-v2.6-pro",
  timestamp: "2026-09-22T00:00:00Z",
  status: "PASS",
  checks: [{ name: "tests", type: "programmatic", passed: true, cmd: "bun test", exitCode: 0 }],
  feedbackForWorker: "",
};

const opts = (dir: string, raw: string) => ({
  runDir: dir,
  taskId: "t1",
  raw,
  label: "verification_report.json",
});

describe("happy path", () => {
  test("a valid artifact parses with no repair", () => {
    const dir = runDir();
    const out = repairArtifact(VerificationReportSchema, opts(dir, JSON.stringify(GOOD)));
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.recoveredAfter).toBe(0);
    expect(out.value.status).toBe("PASS");
  });

  test("raw output is preserved even when it validates", () => {
    const dir = runDir();
    repairArtifact(VerificationReportSchema, opts(dir, JSON.stringify(GOOD)));
    expect(existsSync(join(dir, "repair", "t1.001.raw.json"))).toBe(true);
  });
});

describe("bounded repair", () => {
  test("malformed JSON yields a repair instruction, not a crash", () => {
    const dir = runDir();
    const out = repairArtifact(VerificationReportSchema, opts(dir, "{ not json"));
    expect(out.kind).toBe("repair");
    if (out.kind !== "repair") return;
    expect(out.attempt).toBe(1);
    expect(out.error).toContain("not valid JSON");
    expect(out.instruction).toContain("Send this error back to the verifier");
  });

  test("the Zod error is fed back verbatim", () => {
    const dir = runDir();
    const missingChecks = { ...GOOD, checks: [] };
    const out = repairArtifact(VerificationReportSchema, opts(dir, JSON.stringify(missingChecks)));
    expect(out.kind).toBe("repair");
    if (out.kind !== "repair") return;
    expect(out.error).toContain("checks");
    expect(out.instruction).toContain(out.error);
  });

  test("the expected shape is included in the instruction", () => {
    const dir = runDir();
    const out = repairArtifact(VerificationReportSchema, opts(dir, "null"));
    expect(out.kind).toBe("repair");
    if (out.kind !== "repair") return;
    for (const field of ["taskId", "verifierAgent", "status", "checks", "exitCode"]) {
      expect(out.instruction).toContain(field);
    }
    expect(out.instruction).toContain('"PASS" | "FAIL"');
  });

  test("re-prompts at most twice, then gives up", () => {
    const dir = runDir();
    const bad = JSON.stringify({ taskId: "t1" });

    const first = repairArtifact(VerificationReportSchema, opts(dir, bad));
    expect(first.kind).toBe("repair");

    const second = repairArtifact(VerificationReportSchema, opts(dir, bad));
    expect(second.kind).toBe("repair");
    if (second.kind === "repair") expect(second.attempt).toBe(2);

    const third = repairArtifact(VerificationReportSchema, opts(dir, bad));
    expect(third.kind).toBe("exhausted");
    if (third.kind !== "exhausted") return;
    expect(third.attempts).toBe(3);
    expect(third.maxRepairs).toBe(DEFAULT_MAX_REPAIRS);
  });

  test("the bound is configurable and honoured", () => {
    const dir = runDir();
    const bad = "{}";
    expect(repairArtifact(VerificationReportSchema, { ...opts(dir, bad), maxRepairs: 1 }).kind).toBe(
      "repair",
    );
    expect(repairArtifact(VerificationReportSchema, { ...opts(dir, bad), maxRepairs: 1 }).kind).toBe(
      "exhausted",
    );
  });

  test("a later valid submission is accepted and resets the ledger", () => {
    const dir = runDir();
    repairArtifact(VerificationReportSchema, opts(dir, "{}"));
    const out = repairArtifact(VerificationReportSchema, opts(dir, JSON.stringify(GOOD)));
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.recoveredAfter).toBe(1);

    // Ledger reset, so a later unrelated failure starts from attempt 1.
    const after = repairArtifact(VerificationReportSchema, opts(dir, "{}"));
    expect(after.kind).toBe("repair");
    if (after.kind === "repair") expect(after.attempt).toBe(1);
  });

  test("attempts are tracked per task, not globally", () => {
    const dir = runDir();
    for (const id of ["a", "a", "a"]) {
      repairArtifact(VerificationReportSchema, { ...opts(dir, "{}"), taskId: id });
    }
    const other = repairArtifact(VerificationReportSchema, { ...opts(dir, "{}"), taskId: "b" });
    expect(other.kind).toBe("repair");
    if (other.kind === "repair") expect(other.attempt).toBe(1);
  });
});

describe("failing loudly preserves the evidence", () => {
  test("every raw submission is on disk and named in the failure", () => {
    const dir = runDir();
    const bodies = ['{"a":1}', '{"b":2}', '{"c":3}'];
    let last = repairArtifact(VerificationReportSchema, opts(dir, bodies[0]!));
    last = repairArtifact(VerificationReportSchema, opts(dir, bodies[1]!));
    last = repairArtifact(VerificationReportSchema, opts(dir, bodies[2]!));

    expect(last.kind).toBe("exhausted");
    if (last.kind !== "exhausted") return;
    expect(last.rawPaths.length).toBe(3);
    for (const [i, p] of last.rawPaths.entries()) {
      expect(existsSync(p)).toBe(true);
      expect(readFileSync(p, "utf-8")).toBe(bodies[i]!);
      expect(last.instruction).toContain(p);
    }
  });

  test("the failure tells the model not to fabricate a substitute", () => {
    const dir = runDir();
    let out = repairArtifact(VerificationReportSchema, opts(dir, "{}"));
    out = repairArtifact(VerificationReportSchema, opts(dir, "{}"));
    out = repairArtifact(VerificationReportSchema, opts(dir, "{}"));
    expect(out.kind).toBe("exhausted");
    if (out.kind !== "exhausted") return;
    expect(out.instruction).toContain("do NOT write a substitute report yourself");
    expect(out.instruction).toContain("Do NOT resubmit");
  });

  test("the ledger records the failure for post-mortem", () => {
    const dir = runDir();
    repairArtifact(VerificationReportSchema, opts(dir, "{}"));
    const ledger = readLedger(dir, "t1");
    expect(ledger).not.toBeNull();
    expect(ledger!.attempts).toBe(1);
    expect(ledger!.rawPaths.length).toBe(1);
    expect(ledger!.firstFailedAt).toBeTruthy();
  });
});

describe("no silent coercion (the load-bearing invariant)", () => {
  test("a PASS with no executed check is never repaired into validity", () => {
    const dir = runDir();
    const rubricOnly = {
      ...GOOD,
      checks: [{ name: "looks fine", type: "rubric", passed: true }],
    };
    // Zod accepts the shape; the engine's validateReport is what rejects the
    // verdict. What matters here is that repair never ADDS a cmd/exitCode.
    const out = repairArtifact(VerificationReportSchema, opts(dir, JSON.stringify(rubricOnly)));
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.value.checks[0]!.cmd).toBeUndefined();
    expect(out.value.checks[0]!.exitCode).toBeUndefined();
  });

  test("an exhausted repair returns no value at all", () => {
    const dir = runDir();
    let out = repairArtifact(VerificationReportSchema, opts(dir, "garbage"));
    out = repairArtifact(VerificationReportSchema, opts(dir, "garbage"));
    out = repairArtifact(VerificationReportSchema, opts(dir, "garbage"));
    expect(out.kind).toBe("exhausted");
    expect((out as Record<string, unknown>).value).toBeUndefined();
  });

  test("fields absent from the model's output are not invented", () => {
    const dir = runDir();
    const noFeedback = { ...GOOD };
    delete (noFeedback as Record<string, unknown>).feedbackForWorker;
    const out = repairArtifact(VerificationReportSchema, opts(dir, JSON.stringify(noFeedback)));
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    // Zod's declared .default("") applies — that is the schema's contract,
    // not repair inventing evidence. Evidence fields stay untouched.
    expect(out.value.feedbackForWorker).toBe("");
    expect(out.value.checks[0]!.exitCode).toBe(0);
  });
});

describe("describeSchema", () => {
  test("renders nested objects, arrays, enums and optionality", () => {
    const s = describeSchema(VerificationReportSchema);
    expect(s).toContain("taskId: string");
    expect(s).toContain('status: "PASS" | "FAIL"');
    expect(s).toContain("checks:");
    expect(s).toContain("cmd?: string");
    expect(s).toContain("exitCode?: number");
  });

  test("degrades instead of throwing on an exotic schema", () => {
    expect(() => describeSchema(z.union([z.string(), z.number()]))).not.toThrow();
    expect(() => describeSchema(z.record(z.string()))).not.toThrow();
    expect(() => describeSchema(z.lazy(() => z.string()))).not.toThrow();
    expect(describeSchema(z.string())).toBe("string");
  });
});

describe("no native structured outputs are requested anywhere", () => {
  test("the tree contains no json_schema / response_format request", async () => {
    const { Glob } = await import("bun");
    const root = join(import.meta.dir, "..", "src");
    const hits: string[] = [];
    for await (const file of new Glob("**/*.ts").scan({ cwd: root, absolute: true })) {
      // Strip comments: the modules that implement the fallback path discuss
      // these names in prose. Only an actual request in code is a finding.
      const code = readFileSync(file, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      for (const needle of ["json_schema", "response_format", "responseFormat", "zodResponseFormat"]) {
        if (code.includes(needle)) hits.push(`${file}: ${needle}`);
      }
    }
    // Phase 2.4 has no code to make conditional — this test is the proof,
    // and will fail loudly if someone later adds a provider-level request.
    expect(hits).toEqual([]);
  });
});

// ─── Phase 4b: budget enforcement is optional and honestly labelled ──

describe("--no-budget (Phase 4b)", () => {
  test("parseCommandFlags recognises --no-budget", async () => {
    const { parseCommandFlags } = await import("../src/flags.ts");
    const mint = () => "s1";
    expect(parseCommandFlags("--no-budget fix the bug", mint).budgetEnforced).toBe(false);
    expect(parseCommandFlags("fix the bug", mint).budgetEnforced).toBeUndefined();
    // The request text survives the flag.
    expect(parseCommandFlags("--no-budget fix the bug", mint).request).toBe("fix the bug");
  });

  test("--no-budget warns that it overrides an explicit --budget", async () => {
    const { parseCommandFlags } = await import("../src/flags.ts");
    const f = parseCommandFlags("--budget 30 --no-budget go", () => "s1");
    expect(f.budgetEnforced).toBe(false);
    expect(f.budgetUsd).toBe(30);
    expect(f.warnings.join(" ")).toContain("overrides --budget");
  });

  test("an unenforced budget does not gate dispatch, and survives resume", async () => {
    const { Engine } = await import("../src/engine.ts");
    const dir = mkdtempSync(join(tmpdir(), "nobudget-"));
    const runDir = join(dir, "run");
    const e = Engine.create({
      runDir,
      sessionId: "nb",
      topology: "small-focused",
      tasks: [{ taskId: "t1", title: "one", maxRounds: 99 }],
      budgetUsd: 0.01,
      budgetEnforced: false,
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
      costUsd: 99,
    });

    // Far past the cap, still dispatching.
    expect(e.status().costUsd).toBe(99);
    expect(e.budgetExhausted()).toBe(false);
    expect(e.dispatchable(5).map((t) => t.taskId)).toEqual(["t1"]);
    expect(e.events().some((ev) => ev.type === "budget.exhausted")).toBe(false);

    // The setting is in the log, so a resumed run does not silently re-arm.
    expect(Engine.resume(runDir).budgetEnforced).toBe(false);
  });

  test("enforcement is still the default", async () => {
    const { Engine } = await import("../src/engine.ts");
    const dir = mkdtempSync(join(tmpdir(), "budget-"));
    const e = Engine.create({
      runDir: join(dir, "run"),
      sessionId: "b",
      topology: "small-focused",
      tasks: [{ taskId: "t1", title: "one", maxRounds: 99 }],
      budgetUsd: 0.01,
    });
    expect(e.budgetEnforced).toBe(true);
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
      costUsd: 1,
    });
    expect(e.budgetExhausted()).toBe(true);
    expect(e.dispatchable(5)).toEqual([]);
  });
});

// ─── Review findings: wedge, overwrite, contradictory instruction ────

describe("repair exhaustion through teamwork_verify", () => {
  async function setup(tasks: Array<Record<string, unknown>>) {
    const { teamworkPlan, teamworkDispatch, teamworkVerify } = await import("../src/tools.ts");
    const project = mkdtempSync(join(tmpdir(), "wedge-"));
    const ctx = { agent: "team/sentinel", directory: project, sessionID: "x" } as any;
    await (teamworkPlan as any).execute({ topology: "small-focused", sessionId: "w", tasks, worktrees: false }, ctx);
    const bad = join(project, "bad.json");
    writeFileSync(bad, "{}");
    return {
      project,
      dispatch: () => (teamworkDispatch as any).execute({ sessionId: "w" }, ctx) as Promise<string>,
      verify: (taskId: string) => (teamworkVerify as any).execute({ sessionId: "w", taskId, reportPath: bad }, ctx) as Promise<string>,
    };
  }

  test("marks the task FAILED and frees its slot, so the run moves on", async () => {
    // Concurrency 1: a task left DISPATCHED used to block every other task.
    const r = await setup([{ taskId: "a", title: "a" }, { taskId: "b", title: "b" }]);
    await r.dispatch();
    let out = "";
    for (let i = 0; i < 3; i += 1) out = await r.verify("a");
    expect(out).toContain("task marked FAILED");
    const { Engine } = await import("../src/engine.ts");
    const { runDirFor } = await import("../src/worktree.ts");
    const e = Engine.resume(runDirFor(r.project, "w"));
    expect(e.status().tasks.find((t) => t.taskId === "a")!.status).toBe("FAILED");
    expect(e.dispatchable(5).map((t) => t.taskId)).toEqual(["b"]);
  });

  test("parks dependents and lets the run finish", async () => {
    const r = await setup([{ taskId: "a", title: "a" }, { taskId: "b", title: "b", dependsOn: ["a"] }]);
    await r.dispatch();
    let out = "";
    for (let i = 0; i < 3; i += 1) out = await r.verify("a");
    expect(out).toContain("because they depend on it: b");
    const { Engine } = await import("../src/engine.ts");
    const { runDirFor } = await import("../src/worktree.ts");
    expect(Engine.resume(runDirFor(r.project, "w")).status().state).toBe("DONE");
  });

  test("every rejection is in the hash-chained log", async () => {
    const r = await setup([{ taskId: "a", title: "a" }]);
    await r.dispatch();
    await r.verify("a");
    await r.verify("a");
    const { readEvents, verifyChain } = await import("../src/events.ts");
    const { runDirFor } = await import("../src/worktree.ts");
    const events = readEvents(runDirFor(r.project, "w"));
    const rejected = events.filter((e) => e.type === "artifact.rejected");
    expect(rejected.length).toBe(2);
    expect(rejected[1]!.data).toMatchObject({ attempt: 2, artifact: "verification_report.json" });
    expect(verifyChain(events).ok).toBe(true);
  });
});

describe("raw evidence survives across rounds", () => {
  test("a later round's failure never overwrites an earlier round's", () => {
    const dir = runDir();
    const round1Bad = '{"round":1}';
    repairArtifact(VerificationReportSchema, opts(dir, round1Bad)); // round 1, attempt 1
    repairArtifact(VerificationReportSchema, opts(dir, JSON.stringify(GOOD))); // round 1 accepted
    repairArtifact(VerificationReportSchema, opts(dir, '{"round":2}')); // round 2, attempt 1
    const files = readdirSync(join(dir, "repair")).filter((f) => f.endsWith(".raw.json")).sort();
    expect(files).toEqual(["t1.001.raw.json", "t1.002.raw.json", "t1.003.raw.json"]);
    expect(readFileSync(join(dir, "repair", "t1.001.raw.json"), "utf-8")).toBe(round1Bad);
  });

  test("an accepted report deletes the ledger rather than leaving a stub", () => {
    const dir = runDir();
    repairArtifact(VerificationReportSchema, opts(dir, "{}"));
    repairArtifact(VerificationReportSchema, opts(dir, JSON.stringify(GOOD)));
    expect(existsSync(join(dir, "repair", "t1.ledger.json"))).toBe(false);
  });
});

describe("the instruction agrees with the engine", () => {
  test("it never tells the model to give an unexecuted check an exit code", async () => {
    const { VERIFICATION_REPORT_HINT } = await import("../src/repair.ts");
    expect(VERIFICATION_REPORT_HINT).toContain("Never give it an exit code");
    expect(VERIFICATION_REPORT_HINT).not.toContain("reporting it as failed");
  });

  test("an unexecuted check recorded as the hint says is accepted by the engine", async () => {
    const { validateReport } = await import("../src/engine.ts");
    const report = {
      ...GOOD,
      checks: [
        { name: "tests", type: "programmatic", passed: true, cmd: "bun test", exitCode: 0 },
        { name: "manual review", type: "rubric", passed: false },
      ],
    } as any;
    expect(validateReport(report).ok).toBe(true);
  });
});
