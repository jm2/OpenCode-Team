/**
 * A run killed mid-append leaves a partial final line in events.jsonl.
 *
 * Before: every reader threw a raw SyntaxError — including teamwork_resume,
 * whose job is to detect and report a damaged log. It could not read far
 * enough to say what was wrong.
 */

import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.ts";
import { appendEvent, readEventLog, readEvents, verifyChain } from "../src/events.ts";
import TeamPlugin from "../src/index.ts";

function runWithEvents(): string {
  const runDir = join(mkdtempSync(join(tmpdir(), "log-")), "run");
  const e = Engine.create({
    runDir,
    sessionId: "s",
    topology: "small-focused",
    tasks: [{ taskId: "t1", title: "t" }],
    budgetUsd: 1,
  });
  e.dispatch("t1");
  return runDir;
}

const truncate = (runDir: string) =>
  appendFileSync(join(runDir, "events.jsonl"), '{"seq":4,"ts":"2026', "utf-8");

describe("a truncated trailing line", () => {
  test("readEvents returns the intact prefix instead of throwing", () => {
    const runDir = runWithEvents();
    const before = readEvents(runDir).length;
    truncate(runDir);
    expect(() => readEvents(runDir)).not.toThrow();
    expect(readEvents(runDir).length).toBe(before);
  });

  test("readEventLog reports where the damage starts", () => {
    const runDir = runWithEvents();
    const before = readEvents(runDir).length;
    truncate(runDir);
    const log = readEventLog(runDir);
    expect(log.events.length).toBe(before);
    expect(log.malformedAtLine).toBe(before + 1);
    expect(log.malformedReason).toBeTruthy();
  });

  test("truncation is reported, never silently skipped", () => {
    // Dropping the bad line would let a damaged log verify clean, which is
    // the exact failure this log format exists to prevent.
    const runDir = runWithEvents();
    truncate(runDir);
    appendFileSync(join(runDir, "events.jsonl"), "\n", "utf-8");
    const log = readEventLog(runDir);
    expect(log.malformedAtLine).toBeDefined();
  });

  test("the intact prefix still verifies as a chain", () => {
    const runDir = runWithEvents();
    truncate(runDir);
    expect(verifyChain(readEventLog(runDir).events).ok).toBe(true);
  });

  test("Engine.resume refuses, naming the line and what survived", () => {
    const runDir = runWithEvents();
    truncate(runDir);
    expect(() => Engine.resume(runDir)).toThrow(/line \d+ of events\.jsonl is not valid JSON/);
    expect(() => Engine.resume(runDir)).toThrow(/killed mid-append/);
    expect(() => Engine.resume(runDir)).toThrow(/event\(s\) before it are intact/);
  });

  test("appending after a partial line is refused, not glued onto it", () => {
    const runDir = runWithEvents();
    truncate(runDir);
    const before = readFileSync(join(runDir, "events.jsonl"), "utf-8");
    expect(() => appendEvent(runDir, { type: "task.round", sessionId: "s", taskId: "t1" })).toThrow(
      /refusing to append/,
    );
    // The file is untouched: the fragment has not swallowed a new event.
    expect(readFileSync(join(runDir, "events.jsonl"), "utf-8")).toBe(before);
  });

  test("a warm engine cannot append either", () => {
    // The tip cache would otherwise vouch for a file that has since been cut.
    const runDir = runWithEvents();
    const e = Engine.resume(runDir);
    truncate(runDir);
    expect(() => e.dispatch("t1")).toThrow(/refusing to append/);
  });

  test("damage in the middle of the file is not mistaken for a crash", () => {
    const runDir = runWithEvents();
    const path = join(runDir, "events.jsonl");
    const lines = readFileSync(path, "utf-8").trimEnd().split("\n");
    lines[1] = "{garbage";
    writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");
    const log = readEventLog(runDir);
    expect(log.malformedAtLine).toBe(2);
    expect(log.malformedIsLast).toBe(false);
    expect(() => Engine.resume(runDir)).toThrow(/valid lines follow it/);
  });

  test("the compaction hook reports damage instead of re-injecting stale state", async () => {
    const project = mkdtempSync(join(tmpdir(), "proj-"));
    const runDir = join(project, ".opencode", "teamwork", "s");
    Engine.create({ runDir, sessionId: "s", topology: "small-focused", tasks: [{ taskId: "t1", title: "t" }], budgetUsd: 1 });
    truncate(runDir);
    writeFileSync(join(project, ".opencode", "teamwork", "LATEST.json"), JSON.stringify({ sessionId: "s", createdAt: "x" }));
    const hooks: any = await TeamPlugin({ directory: project, client: { app: { log: async () => {} } } } as any);
    const out = { context: [] as string[] };
    await hooks["experimental.session.compacting"]({ sessionID: "z" }, out);
    expect(out.context.join("\n")).toContain("killed mid-append");
    expect(out.context.join("\n")).not.toContain("Active Teamwork run");
  });

  test("an undamaged log still resumes", () => {
    const runDir = runWithEvents();
    expect(Engine.resume(runDir).sessionId).toBe("s");
  });

  test("a tampered (not truncated) log is still refused as corrupt", () => {
    const runDir = runWithEvents();
    const path = join(runDir, "events.jsonl");
    const orig = readEvents(runDir);
    writeFileSync(
      path,
      orig
        .map((e, i) => JSON.stringify(i === 1 ? { ...e, ts: "1999-01-01T00:00:00Z" } : e))
        .join("\n") + "\n",
      "utf-8",
    );
    expect(() => Engine.resume(runDir)).toThrow(/corrupt at seq/);
  });
});

describe("an unreadable plan.dag.json", () => {
  test("resume names the file instead of leaking a SyntaxError", () => {
    const runDir = runWithEvents();
    writeFileSync(join(runDir, "plan.dag.json"), '{"sessionId":"s","tasks":[', "utf-8");
    expect(() => Engine.resume(runDir)).toThrow(/plan\.dag\.json is not valid JSON/);
  });

  test("it does not resume into a run with silently zero tasks", () => {
    // Falling through with tasks: [] gives a run that dispatches nothing and
    // reports no reason for it.
    const runDir = runWithEvents();
    writeFileSync(join(runDir, "plan.dag.json"), "{oops", "utf-8");
    let resumed: Engine | null = null;
    try { resumed = Engine.resume(runDir); } catch { /* expected */ }
    expect(resumed).toBeNull();
  });
});
