/**
 * One run's worktrees and branches must never be reachable from another run.
 *
 * Three ways they were, all reproduced below against the unfixed code:
 *   - agent branches were suffixed with `sessionId.slice(0, 8)`, which for a
 *     minted ISO-timestamp id is the year and month;
 *   - hyphens in both agent names and session ids made a joined name
 *     ambiguous ("w-v" in "1" vs "w" in "v-1");
 *   - `list()` matched run directories by substring, so run "run1" claimed the
 *     worktrees of run "run10".
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktreeManager, git } from "../src/worktree.ts";
import { mintSessionId } from "../src/tools.ts";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wt-"));
  git(["init", "-q", dir]);
  git(["config", "user.email", "t@example.invalid"], dir);
  git(["config", "user.name", "t"], dir);
  writeFileSync(join(dir, "f.txt"), "x");
  git(["add", "-A"], dir);
  git(["commit", "-qm", "init"], dir);
  return dir;
}

const branches = (dir: string) => git(["branch", "--list"], dir).stdout;

describe("minted session ids", () => {
  test("share their first eight characters (the original bug's precondition)", () => {
    const a = mintSessionId();
    const b = mintSessionId();
    expect(a).not.toBe(b);
    expect(a.slice(0, 8)).toBe(b.slice(0, 8));
  });

  test("two runs with the same agent name both get a real worktree", () => {
    const dir = repo();
    const wm = createWorktreeManager();
    const [A, B] = [mintSessionId(), mintSessionId()];
    wm.initSession(A, { cwd: dir });
    wm.initSession(B, { cwd: dir });
    const a = wm.addAgent("builder-task-1", A, { cwd: dir });
    const b = wm.addAgent("builder-task-1", B, { cwd: dir });
    expect(a.branch).not.toBe(b.branch);
    // A worktree with no checkout is the silent version of this failure: the
    // worker ends up editing the main checkout instead.
    expect(existsSync(join(a.path, "f.txt"))).toBe(true);
    expect(existsSync(join(b.path, "f.txt"))).toBe(true);
  });
});

describe("names are unambiguous", () => {
  test("hyphens in both parts cannot produce the same branch", () => {
    const dir = repo();
    const wm = createWorktreeManager();
    wm.initSession("1", { cwd: dir });
    wm.initSession("v-1", { cwd: dir });
    const a = wm.addAgent("w-v", "1", { cwd: dir });
    const b = wm.addAgent("w", "v-1", { cwd: dir });
    expect(a.branch).not.toBe(b.branch);
    expect(existsSync(join(b.path, "f.txt"))).toBe(true);
  });

  test("the session id is its own path component", () => {
    const dir = repo();
    const wm = createWorktreeManager();
    wm.initSession("s1", { cwd: dir });
    expect(wm.addAgent("worker", "s1", { cwd: dir }).branch).toBe("teamwork/run/s1/agent-worker");
  });
});

describe("cleanup touches only its own run", () => {
  test("another run's pruned-but-kept branch survives", () => {
    const dir = repo();
    const wm = createWorktreeManager();
    wm.initSession("1", { cwd: dir });
    wm.initSession("v-1", { cwd: dir });
    wm.addAgent("worker", "1", { cwd: dir });
    const keep = wm.addAgent("keeper", "v-1", { cwd: dir });
    // Nothing checked out protects it: git refuses to delete a branch in use,
    // which masked the original bug for live worktrees.
    git(["worktree", "remove", "--force", keep.path], dir);
    wm.cleanupSession("1", { cwd: dir });
    expect(branches(dir)).toContain(keep.branch);
  });

  test("a run whose id is a prefix of another's leaves it alone", () => {
    const dir = repo();
    const wm = createWorktreeManager();
    wm.initSession("run1", { cwd: dir });
    wm.initSession("run10", { cwd: dir });
    const w = wm.addAgent("worker", "run10", { cwd: dir });
    writeFileSync(join(w.path, "uncommitted.txt"), "work in progress");

    expect(wm.list("run1", { cwd: dir }).some((i) => i.path.includes("run10"))).toBe(false);
    wm.cleanupSession("run1", { cwd: dir });

    expect(existsSync(join(w.path, "uncommitted.txt"))).toBe(true);
    expect(branches(dir)).toContain(w.branch);
    expect(branches(dir)).toContain("teamwork/base-run10");
  });

  test("its own branches and worktrees are removed, including pruned ones", () => {
    const dir = repo();
    const wm = createWorktreeManager();
    const A = mintSessionId();
    wm.initSession(A, { cwd: dir });
    const live = wm.addAgent("worker", A, { cwd: dir });
    const pruned = wm.addAgent("scout", A, { cwd: dir });
    git(["worktree", "remove", "--force", pruned.path], dir);

    wm.cleanupSession(A, { cwd: dir });

    expect(existsSync(live.path)).toBe(false);
    for (const b of [live.branch, pruned.branch, `teamwork/base-${A}`]) {
      expect(branches(dir)).not.toContain(b);
    }
    expect(git(["worktree", "list"], dir).stdout).not.toContain(live.path);
  });

  test("a worktree on a branch named by an older version is still cleaned up", () => {
    const dir = repo();
    const wm = createWorktreeManager();
    const A = "legacy-run";
    wm.initSession(A, { cwd: dir });
    const legacyBranch = `teamwork/agent-worker-${A.slice(0, 8)}`;
    const path = join(dir, ".opencode", "teamwork", A, "worktrees", "agent-worker");
    git(["worktree", "add", path, "-b", legacyBranch, `teamwork/base-${A}`], dir);

    wm.cleanupSession(A, { cwd: dir });

    expect(existsSync(path)).toBe(false);
    expect(branches(dir)).not.toContain(legacyBranch);
  });
});
