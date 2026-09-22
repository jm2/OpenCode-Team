/**
 * opencode loads a plugin module by walking Object.values() of it: each
 * distinct function is called as a plugin, an object is accepted only if it
 * has a `server` function, and anything else throws "Plugin export is not a
 * function" — after which opencode skips the plugin and says so only in its
 * log. Verified against opencode 1.18.32, where both the published 0.2.1 and
 * this repository's entry module failed to load because of an exported `id`
 * string.
 *
 * This mirrors that rule, so a stray export fails here instead of silently
 * in a user's editor.
 */

import { expect, test } from "bun:test";
import * as entry from "../src/index.ts";

/** opencode's rule, restated. */
function resolvesToPlugin(value: unknown): boolean {
  if (typeof value === "function") return true;
  return !!value && typeof value === "object" && typeof (value as { server?: unknown }).server === "function";
}

test("every runtime export of the entry module is a plugin", () => {
  for (const [name, value] of Object.entries(entry)) {
    expect({ name, ok: resolvesToPlugin(value) }).toEqual({ name, ok: true });
  }
});

test("the exports resolve to exactly one plugin, so it initialises once", () => {
  // Aliases are fine: the loader de-duplicates by identity. A second distinct
  // function would be called as a plugin with the plugin's input.
  expect(new Set(Object.values(entry)).size).toBe(1);
});
