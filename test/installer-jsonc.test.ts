/**
 * The installer reads opencode.json as JSONC. Comments must be stripped only
 * outside strings: the old regexes truncated URLs and rewrote glob patterns.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonc, stripJsonc } from "../src/cli/jsonc.ts";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

describe("strings are left alone", () => {
  const cases: Array<[string, unknown]> = [
    ['{"p":["file:///Users/me/plugin/dist/index.js"]}', { p: ["file:///Users/me/plugin/dist/index.js"] }],
    ['{"u":"https://gw.example.invalid//v1"}', { u: "https://gw.example.invalid//v1" }],
    ['{"h":"a // b"}', { h: "a // b" }],
    ['{"edit":{"src/**/*.ts":"allow"}}', { edit: { "src/**/*.ts": "allow" } }],
    ['{"q":"say \\"/* hi */\\""}', { q: 'say "/* hi */"' }],
    ['{"b":"back\\\\"}', { b: "back\\" }],
  ];
  for (const [src, want] of cases) {
    test(src, () => expect(parseJsonc(src)).toEqual(want));
  }
});

describe("comments and trailing commas are stripped", () => {
  test("line comments", () => {
    expect(parseJsonc('{\n  // a comment\n  "a": 1 // trailing\n}')).toEqual({ a: 1 });
  });
  test("block comments", () => {
    expect(parseJsonc('{ /* one */ "a": /* two */ 1 }')).toEqual({ a: 1 });
  });
  test("trailing commas in objects and arrays", () => {
    expect(parseJsonc('{ "a": [1, 2, ], "b": 3, }')).toEqual({ a: [1, 2], b: 3 });
  });
  test("a trailing comma before a comment and a closing brace", () => {
    expect(parseJsonc('{ "a": 1, // last\n}')).toEqual({ a: 1 });
  });
  test("commas between values are kept", () => {
    expect(stripJsonc('{"a":1,"b":2}')).toBe('{"a":1,"b":2}');
  });
});

describe("the installer round-trips a real config", () => {
  function install(config: string): { code: number; written: any } {
    const dir = mkdtempSync(join(tmpdir(), "jsonc-"));
    const path = join(dir, "opencode.json");
    writeFileSync(path, config, "utf-8");
    let code = 0;
    try {
      execFileSync(process.execPath, [CLI, "install", "--preset", "google", "--yes", "--config", path], {
        stdio: "ignore",
      });
    } catch (e: any) {
      code = e.status ?? 1;
    }
    return { code, written: JSON.parse(readFileSync(path, "utf-8").replace(/^\s*\/\/.*$/gm, "")) };
  }

  test("a permission glob is preserved, not rewritten to src*.ts", () => {
    const r = install('{\n  "permission": { "edit": { "src/**/*.ts": "allow" } }\n}\n');
    expect(r.code).toBe(0);
    expect(r.written.permission.edit).toEqual({ "src/**/*.ts": "allow" });
  });

  test("a file:// URL no longer stops the installer", () => {
    const r = install('{\n  // mine\n  "provider": { "x": { "options": { "baseURL": "file:///tmp/x" } } }\n}\n');
    expect(r.code).toBe(0);
    expect(r.written.provider.x.options.baseURL).toBe("file:///tmp/x");
  });
});
