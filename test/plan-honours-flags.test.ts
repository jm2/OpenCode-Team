/**
 * Flags parsed in code from /teamwork must reach the engine in code, not
 * only if the model copies them into teamwork_plan's arguments.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.ts";
import TeamPlugin from "../src/index.ts";
import { readRunPointer } from "../src/run-pointer.ts";
import { teamworkPlan } from "../src/tools.ts";
import { runDirFor } from "../src/worktree.ts";

async function command(project: string, args: string, sessionID = "oc1") {
  const hooks: any = await TeamPlugin({ directory: project, client: { app: { log: async () => {} } } } as any);
  await hooks["command.execute.before"]({ command: "teamwork", sessionID, arguments: args }, {});
  return readRunPointer(project)!;
}

const plan = (project: string, args: Record<string, unknown>, sessionID = "oc1") =>
  (teamworkPlan as any).execute(
    { tasks: [{ taskId: "t1", title: "t" }], worktrees: false, ...args },
    { agent: "team/sentinel", directory: project, sessionID },
  ) as Promise<string>;

describe("teamwork_plan applies the user's parsed flags", () => {
  test("when the model passes none of them", async () => {
    const project = mkdtempSync(join(tmpdir(), "flags-"));
    const ptr = await command(project, "--budget 0.5 --concurrency 3 --topology iterative-coding fix it");
    const out = await plan(project, { topology: "small-focused" });

    const e = Engine.resume(runDirFor(project, ptr.sessionId));
    expect(e.budgetUsd).toBe(0.5);
    expect(e.maxConcurrency).toBe(3);
    expect(e.topology).toBe("iterative-coding");
    expect(out).toContain("--budget 0.5 from your command");
  });

  test("the run lands in the directory that holds request.md", async () => {
    const project = mkdtempSync(join(tmpdir(), "flags-"));
    const ptr = await command(project, "fix it");
    await plan(project, { topology: "small-focused" });
    const runs = readdirSync(join(project, ".opencode", "teamwork")).filter((n) => n !== "LATEST.json");
    expect(runs).toEqual([ptr.sessionId]);
    expect(existsSync(join(runDirFor(project, ptr.sessionId), "request.md"))).toBe(true);
    expect(existsSync(join(runDirFor(project, ptr.sessionId), "events.jsonl"))).toBe(true);
  });

  test("the user's flag wins over a different value from the model, and says so", async () => {
    const project = mkdtempSync(join(tmpdir(), "flags-"));
    const ptr = await command(project, "--budget 2 fix it");
    const out = await plan(project, { topology: "small-focused", budgetUsd: 50 });
    expect(Engine.resume(runDirFor(project, ptr.sessionId)).budgetUsd).toBe(2);
    expect(out).toContain("the plan asked for 50");
  });

  test("with no flags, the model's arguments still apply", async () => {
    const project = mkdtempSync(join(tmpdir(), "flags-"));
    const ptr = await command(project, "fix it");
    await plan(project, { topology: "small-focused", budgetUsd: 4 });
    expect(Engine.resume(runDirFor(project, ptr.sessionId)).budgetUsd).toBe(4);
  });

  test("another session's command is not applied", async () => {
    const project = mkdtempSync(join(tmpdir(), "flags-"));
    await command(project, "--budget 0.5 fix it", "someone-else");
    const out = await plan(project, { topology: "small-focused", sessionId: "mine" }, "oc1");
    expect(Engine.resume(runDirFor(project, "mine")).budgetUsd).not.toBe(0.5);
    expect(out).not.toContain("from your command");
  });
});
