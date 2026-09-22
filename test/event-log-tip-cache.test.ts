/**
 * The cached log tip must never outrank the file.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readEvents, verifyChain } from "../src/events.ts";

const run = () => join(mkdtempSync(join(tmpdir(), "tip-")), "run");

describe("tip cache validity", () => {
  test("an externally rewritten log does not produce a corrupt chain", () => {
    const runDir = run();
    appendEvent(runDir, { type: "session.start", sessionId: "c" });

    // Something else appends to the log: a second process, a restore, an
    // operator. The cached tip is now stale.
    const path = join(runDir, "events.jsonl");
    const first = readEvents(runDir)[0]!;
    const second = { ...first, seq: 2, prevHash: first.hash };
    const rehashed = {
      ...second,
      hash: require("node:crypto")
        .createHash("sha256")
        .update(`${first.hash}\n${canonical({ ...second, hash: undefined })}`)
        .digest("hex"),
    };
    writeFileSync(path, `${JSON.stringify(first)}\n${JSON.stringify(rehashed)}\n`, "utf-8");

    appendEvent(runDir, { type: "session.done", sessionId: "c" });

    const seqs = readEvents(runDir).map((e) => e.seq);
    // The new event must follow the file, not the remembered tip.
    expect(seqs).toEqual([1, 2, 3]);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test("consecutive appends still chain correctly", () => {
    const runDir = run();
    for (let i = 0; i < 5; i += 1) {
      appendEvent(runDir, { type: "task.round", sessionId: "c", taskId: `t${i}` });
    }
    const events = readEvents(runDir);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(verifyChain(events).ok).toBe(true);
  });

  test("a deleted log starts a fresh chain rather than resuming a remembered one", () => {
    const runDir = run();
    appendEvent(runDir, { type: "session.start", sessionId: "c" });
    appendEvent(runDir, { type: "task.round", sessionId: "c", taskId: "t" });
    rmSync(join(runDir, "events.jsonl"));

    const next = appendEvent(runDir, { type: "session.start", sessionId: "c" });
    expect(next.seq).toBe(1);
    expect(next.prevHash).toBe("0".repeat(64));
    expect(verifyChain(readEvents(runDir)).ok).toBe(true);
  });

  test("two run directories do not share a tip", () => {
    const a = run();
    const b = run();
    appendEvent(a, { type: "session.start", sessionId: "a" });
    appendEvent(a, { type: "task.round", sessionId: "a", taskId: "t" });
    const firstInB = appendEvent(b, { type: "session.start", sessionId: "b" });
    expect(firstInB.seq).toBe(1);
    expect(verifyChain(readEvents(b)).ok).toBe(true);
  });
});

/** Mirrors the canonical JSON used by hashEvent, for the rewrite above. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
