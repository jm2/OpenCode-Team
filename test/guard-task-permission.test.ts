/**
 * "A worker cannot fan out its own swarm" needs a second line of defence,
 * the same way "the verifier cannot edit code" has one.
 */

import { describe, expect, test } from "bun:test";
import { RoleRegistry, TASK_TOOLS, isTaskTool } from "../src/guard.ts";
import { agentPermissions } from "../src/templates.ts";

const LEAVES = [
  "worker",
  "proof-worker",
  "verifier",
  "falsifier",
  "scout",
  "proposer",
  "synthesizer",
  "crafter",
];
const ENGINE = ["sentinel", "orchestrator"];

describe("task: deny is enforced at runtime", () => {
  test("every leaf role declares it", () => {
    for (const name of LEAVES) expect(agentPermissions(name)!.task).toBe("deny");
  });

  test("every leaf role is refused the task tool", () => {
    for (const name of LEAVES) {
      const r = new RoleRegistry();
      r.remember("s", `team/${name}`);
      expect(r.blockReason("s", "task")).toContain("may not spawn subagents");
    }
  });

  test("the orchestrating roles may still dispatch", () => {
    for (const name of ENGINE) {
      const r = new RoleRegistry();
      r.remember("s", `team/${name}`);
      expect(agentPermissions(name)!.task).toBe("allow");
      expect(r.blockReason("s", "task")).toBeNull();
    }
  });

  test("a worker may still edit — only the task tool is new", () => {
    const r = new RoleRegistry();
    r.remember("s", "team/worker");
    expect(r.blockReason("s", "edit")).toBeNull();
    expect(r.blockReason("s", "write")).toBeNull();
    expect(r.blockReason("s", "task")).not.toBeNull();
  });

  test("the verifier is still refused write tools", () => {
    const r = new RoleRegistry();
    r.remember("s", "team/verifier");
    expect(r.blockReason("s", "edit")).toContain("read-only");
    expect(r.blockReason("s", "write")).toContain("read-only");
  });

  test("unrelated tools are untouched", () => {
    const r = new RoleRegistry();
    r.remember("s", "team/worker");
    for (const t of ["bash", "read", "grep", "glob", "webfetch", "teamwork_status"]) {
      expect(r.blockReason("s", t)).toBeNull();
    }
  });

  test("non-team and unknown sessions fail open", () => {
    const r = new RoleRegistry();
    r.remember("s", "build");
    expect(r.blockReason("s", "task")).toBeNull();
    expect(r.blockReason("never-seen", "task")).toBeNull();
  });

  test("an effective permission override wins over the template", () => {
    const r = new RoleRegistry();
    r.remember("s", "team/worker");
    r.setPermissions("team/worker", {
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
      task: "allow",
    });
    expect(r.blockReason("s", "task")).toBeNull();
  });

  test("the tool list is narrow and case-insensitive", () => {
    expect(TASK_TOOLS).toEqual(["task"]);
    expect(isTaskTool("TASK")).toBe(true);
    expect(isTaskTool("multitask")).toBe(false);
  });
});
