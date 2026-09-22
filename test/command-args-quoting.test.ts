/**
 * `opencode run --command teamwork "<message>"` passes the command hook the
 * message wrapped in double quotes (observed with opencode 1.18.32). The
 * flags inside it must still be parsed.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import TeamPlugin from "../src/index.ts";

async function run(args: string) {
  const project = mkdtempSync(join(tmpdir(), "args-"));
  const hooks: any = await TeamPlugin({ directory: project, client: { app: { log: async () => {} } } } as any);
  await hooks["command.execute.before"]({ command: "teamwork", sessionID: "s", arguments: args }, {});
  return JSON.parse(readFileSync(join(project, ".opencode", "teamwork", "LATEST.json"), "utf-8"));
}

describe("arguments wrapped by the opencode CLI", () => {
  test("flags inside the quotes are parsed", async () => {
    const p = await run('"fix the off-by-one --budget 0.5 --topology iterative-coding"');
    expect(p.budgetUsd).toBe(0.5);
    expect(p.topology).toBe("iterative-coding");
    expect(p.request).toBe("fix the off-by-one");
  });

  test("typed TUI arguments are unchanged", async () => {
    const p = await run("--budget 2 fix it");
    expect(p.budgetUsd).toBe(2);
    expect(p.request).toBe("fix it");
  });

  test("quotes inside the request are left alone", async () => {
    const p = await run('rename "foo" to "bar" --budget 1');
    expect(p.budgetUsd).toBe(1);
    expect(p.request).toBe('rename "foo" to "bar"');
  });
});
