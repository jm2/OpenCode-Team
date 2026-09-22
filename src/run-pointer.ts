/**
 * The run pointer: `.opencode/teamwork/LATEST.json`.
 *
 * Written by the `command.execute.before` hook after it parses `/teamwork`
 * flags in code, and read by `teamwork_plan` so those flags reach the engine
 * without depending on the model to copy them across.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RunPointer {
  sessionId: string;
  topology?: string;
  budgetUsd?: number;
  maxConcurrency?: number;
  /** False when `--no-budget` was passed. */
  budgetEnforced?: boolean;
  request?: string;
  createdAt: string;
  /** The opencode session the command ran in. */
  opencodeSessionID?: string;
}

export function latestPointerPath(projectDir: string): string {
  return join(projectDir, ".opencode", "teamwork", "LATEST.json");
}

export function writeRunPointer(projectDir: string, pointer: RunPointer): void {
  mkdirSync(join(projectDir, ".opencode", "teamwork"), { recursive: true });
  writeFileSync(latestPointerPath(projectDir), `${JSON.stringify(pointer, null, 2)}\n`, "utf-8");
}

export function readRunPointer(projectDir: string): RunPointer | null {
  const path = latestPointerPath(projectDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RunPointer;
  } catch {
    return null;
  }
}

/**
 * The pointer, but only when it belongs to the calling session.
 *
 * LATEST.json is per project, so another session's /teamwork can overwrite
 * it. Matching on the opencode session id keeps one conversation's flags from
 * being applied to a plan made in another.
 */
export function pointerFor(projectDir: string, opencodeSessionID: string): RunPointer | null {
  const pointer = readRunPointer(projectDir);
  if (!pointer || !pointer.opencodeSessionID) return null;
  return pointer.opencodeSessionID === opencodeSessionID ? pointer : null;
}
