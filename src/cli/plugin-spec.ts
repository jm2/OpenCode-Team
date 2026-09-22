/**
 * Resolving and recognising the plugin entry this installer writes.
 *
 * Two kinds of entry refer to this plugin: an npm spec
 * ("opencode-teamwork" or "opencode-teamwork@<version>") and a file:// URL to
 * a local build of this package. opencode accepts both; the local form is how
 * a fork or checkout is loaded instead of whatever npm publishes.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PACKAGE_NAME = "opencode-teamwork";

/** Nearest package.json at or above `start` whose name is this package. */
export function findPackageRoot(start: string, depth = 8): string | null {
  let dir = start;
  for (let i = 0; i < depth; i += 1) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        if (JSON.parse(readFileSync(pj, "utf-8")).name === PACKAGE_NAME) return dir;
      } catch {
        // unreadable package.json: keep walking
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** True for a file:// URL pointing into a build of this package. */
export function isLocalTeamworkBuild(spec: unknown): boolean {
  if (typeof spec !== "string" || !spec.startsWith("file://")) return false;
  let path: string;
  try {
    path = fileURLToPath(spec);
  } catch {
    return false;
  }
  return findPackageRoot(dirname(path)) !== null;
}

export function isTeamworkNpmSpec(spec: unknown): boolean {
  return typeof spec === "string" && (spec === PACKAGE_NAME || spec.startsWith(`${PACKAGE_NAME}@`));
}

export function isTeamworkEntry(spec: unknown): boolean {
  return isTeamworkNpmSpec(spec) || isLocalTeamworkBuild(spec);
}

export type PluginArg = { ok: true; spec: string; local: boolean } | { ok: false; error: string };

/**
 * Turn `--plugin <value>` into a config entry.
 *
 *   local            the build of the checkout this CLI runs from
 *   <path>           a checkout directory or a built entry file
 *   file:///...      used as given, after checking it exists
 *   anything else    treated as an npm spec
 */
export function resolvePluginArg(value: string, cliDir: string): PluginArg {
  if (value === "local") {
    const root = findPackageRoot(cliDir);
    if (!root) return { ok: false, error: `--plugin local: cannot find this package's root above ${cliDir}` };
    return localEntry(root);
  }
  if (value.startsWith("file://")) {
    let path: string;
    try {
      path = fileURLToPath(value);
    } catch {
      return { ok: false, error: `--plugin: not a valid file URL: ${value}` };
    }
    return existsSync(path)
      ? { ok: true, spec: value, local: true }
      : { ok: false, error: `--plugin: ${path} does not exist` };
  }
  const looksLikePath = isAbsolute(value) || value.startsWith(".") || value.startsWith("~");
  if (looksLikePath) {
    const path = resolve(value.startsWith("~") ? join(homedir(), value.slice(1)) : value);
    if (!existsSync(path)) return { ok: false, error: `--plugin: ${path} does not exist` };
    if (statSync(path).isDirectory()) return localEntry(path);
    return { ok: true, spec: pathToFileURL(path).href, local: true };
  }
  return { ok: true, spec: value, local: false };
}

function localEntry(root: string): PluginArg {
  const entry = join(root, "dist", "index.js");
  if (!existsSync(entry)) {
    return { ok: false, error: `no build at ${entry}. Run \`bun run build\` in ${root} first.` };
  }
  return { ok: true, spec: pathToFileURL(entry).href, local: true };
}
