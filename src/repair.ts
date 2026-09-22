/**
 * Bounded repair for the model-authored artifact boundary.
 *
 * `verification_report.json` is the only free-form model JSON this plugin
 * reads (see docs/GROUND-TRUTH.md §6): the verifier writes it to disk, the
 * sentinel hands over the path, and `teamwork_verify` does `JSON.parse` +
 * Zod. A model that cannot be schema-constrained — MiMo supports JSON mode
 * but not native `json_schema` — has to hit that shape by prompting alone,
 * so on a multi-task DAG a parse failure is a live risk rather than a
 * theoretical one.
 *
 * Upstream's behaviour on failure was to return an error string and let the
 * model resubmit as many times as it liked, discarding the raw output each
 * time. That neither bounds the loop nor preserves the evidence.
 *
 * This module adds:
 *   - a per-task attempt counter persisted in the run directory, so the bound
 *     survives the tool call that enforces it;
 *   - the Zod error and the expected shape fed back verbatim as a repair
 *     instruction;
 *   - every raw submission written to disk before it is judged;
 *   - a loud, terminal failure once the bound is spent.
 *
 * What it deliberately does NOT do: coerce, default-fill, or fabricate a
 * valid object. A verification report that was never produced is worse than
 * no report — the whole point of the artifact bus is that a PASS is evidence.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";

/** Re-prompts allowed after the first failure. "Once, at most twice." */
export const DEFAULT_MAX_REPAIRS = 2;

export interface RepairLedger {
  taskId: string;
  attempts: number;
  maxRepairs: number;
  firstFailedAt: string;
  lastError: string;
  rawPaths: string[];
}

export type RepairOutcome<T> =
  | { kind: "ok"; value: T; recoveredAfter: number }
  | {
      kind: "repair";
      attempt: number;
      maxRepairs: number;
      error: string;
      rawPath: string;
      instruction: string;
    }
  | {
      kind: "exhausted";
      attempts: number;
      maxRepairs: number;
      error: string;
      rawPath: string;
      rawPaths: string[];
      instruction: string;
    };

function repairDir(runDir: string): string {
  return join(runDir, "repair");
}

function ledgerPath(runDir: string, taskId: string): string {
  return join(repairDir(runDir), `${sanitize(taskId)}.ledger.json`);
}

/** Task ids are already validated by the engine; belt and braces for paths. */
function sanitize(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "unknown";
}

export function readLedger(runDir: string, taskId: string): RepairLedger | null {
  const path = ledgerPath(runDir, taskId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RepairLedger;
  } catch {
    return null;
  }
}

function writeLedger(runDir: string, ledger: RepairLedger): void {
  mkdirSync(repairDir(runDir), { recursive: true });
  writeFileSync(ledgerPath(runDir, ledger.taskId), `${JSON.stringify(ledger, null, 2)}\n`, "utf-8");
}

export function clearLedger(runDir: string, taskId: string): void {
  rmSync(ledgerPath(runDir, taskId), { force: true });
}

/**
 * Persist a raw submission before judging it. Returns the path.
 *
 * This runs on every submission, valid or not: when a run does fail, the
 * operator needs what the model actually emitted, not a summary of why it
 * was rejected. Files are numbered per task across the whole run and never
 * reused — numbering them by repair attempt restarted at 1 each round, so a
 * later round's first failure overwrote an earlier round's evidence.
 */
export function preserveRaw(runDir: string, taskId: string, raw: string): string {
  const dir = repairDir(runDir);
  mkdirSync(dir, { recursive: true });
  const prefix = `${sanitize(taskId)}.`;
  const taken = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".raw.json"))
    .map((f) => Number.parseInt(f.slice(prefix.length), 10))
    .filter((n) => Number.isFinite(n));
  const next = (taken.length > 0 ? Math.max(...taken) : 0) + 1;
  const path = join(dir, `${prefix}${String(next).padStart(3, "0")}.raw.json`);
  writeFileSync(path, raw, "utf-8");
  return path;
}

// ─── Describing the expected shape ───────────────────────────────────

/**
 * A compact, model-readable sketch of a Zod schema.
 *
 * Walks the public `_def` surface defensively — anything unrecognised
 * degrades to its type name rather than throwing, because a repair path that
 * crashes while explaining a crash is worse than a vague hint.
 */
export function describeSchema(schema: z.ZodTypeAny, depth = 0): string {
  if (depth > 4) return "…";
  const def: any = (schema as any)?._def;
  if (!def) return "unknown";
  const t: string = def.typeName ?? "";

  switch (t) {
    case "ZodObject": {
      const shape = typeof def.shape === "function" ? def.shape() : def.shape;
      if (!shape || typeof shape !== "object") return "object";
      const pad = "  ".repeat(depth + 1);
      const rows = Object.entries(shape).map(([k, v]) => {
        const child = v as z.ZodTypeAny;
        const optional = isOptionalish(child) ? "?" : "";
        return `${pad}${k}${optional}: ${describeSchema(child, depth + 1)}`;
      });
      return `{\n${rows.join(",\n")}\n${"  ".repeat(depth)}}`;
    }
    case "ZodArray":
      return `${describeSchema(def.type, depth)}[]`;
    case "ZodEnum":
      return (def.values ?? []).map((v: string) => JSON.stringify(v)).join(" | ") || "enum";
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
      return describeSchema(def.innerType, depth);
    case "ZodEffects":
      return describeSchema(def.schema, depth);
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    default:
      return t.replace(/^Zod/, "").toLowerCase() || "unknown";
  }
}

function isOptionalish(schema: z.ZodTypeAny): boolean {
  const t = (schema as any)?._def?.typeName;
  return t === "ZodOptional" || t === "ZodDefault" || t === "ZodNullable";
}

// ─── The repair step ─────────────────────────────────────────────────

export interface RepairOptions {
  runDir: string;
  taskId: string;
  /** The raw text the model produced, exactly as read. */
  raw: string;
  label: string;
  maxRepairs?: number;
  /** Extra, domain-specific guidance appended to the instruction. */
  hint?: string;
}

/**
 * Parse `raw` against `schema`, bounding how many times the model may retry.
 *
 * On success the ledger is cleared and the parsed value returned. On failure
 * the raw text is preserved, the counter advanced, and either a repair
 * instruction or a terminal failure returned. The caller surfaces the
 * instruction to the model; the bound is enforced here, in code.
 */
export function repairArtifact<T>(
  schema: z.ZodType<T>,
  options: RepairOptions,
): RepairOutcome<T> {
  const { runDir, taskId, raw, label } = options;
  const maxRepairs = options.maxRepairs ?? DEFAULT_MAX_REPAIRS;
  const prior = readLedger(runDir, taskId);
  const priorAttempts = prior && typeof prior.attempts === "number" ? prior.attempts : 0;
  const attempt = priorAttempts + 1;

  const rawPath = preserveRaw(runDir, taskId, raw);

  // Two failure modes, one path: malformed JSON and well-formed JSON of the
  // wrong shape both land here with a readable reason.
  let parsedJson: unknown;
  let error: string | null = null;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    error = `not valid JSON — ${(err as Error).message}`;
  }

  if (error === null) {
    const result = schema.safeParse(parsedJson);
    if (result.success) {
      if (priorAttempts > 0) clearLedger(runDir, taskId);
      return { kind: "ok", value: result.data, recoveredAfter: priorAttempts };
    }
    error = result.error.issues
      .slice(0, 12)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
  }

  const ledger: RepairLedger = {
    taskId,
    attempts: attempt,
    maxRepairs,
    firstFailedAt: prior?.firstFailedAt ?? new Date().toISOString(),
    lastError: error,
    rawPaths: [...(prior?.rawPaths ?? []), rawPath],
  };
  writeLedger(runDir, ledger);

  const shape = describeSchema(schema as unknown as z.ZodTypeAny);

  if (attempt > maxRepairs) {
    return {
      kind: "exhausted",
      attempts: attempt,
      maxRepairs,
      error,
      rawPath,
      rawPaths: ledger.rawPaths,
      instruction: [
        `${label} FAILED VALIDATION ${attempt} times. The engine has marked this task FAILED.`,
        `  last error: ${error}`,
        ``,
        `Every raw submission has been preserved:`,
        ...ledger.rawPaths.map((p) => `  ${p}`),
        ``,
        `Do NOT resubmit and do NOT write a substitute report yourself: a report that`,
        `no verifier produced is worse than none. Report this failure to the user`,
        `with the paths above, then carry on with whatever else is dispatchable.`,
      ].join("\n"),
    };
  }

  return {
    kind: "repair",
    attempt,
    maxRepairs,
    error,
    rawPath,
    instruction: [
      `${label} failed validation (repair ${attempt} of ${maxRepairs}).`,
      `  error: ${error}`,
      `  the submission was saved to: ${rawPath}`,
      ``,
      `Send this error back to the verifier and have it write the report again.`,
      `Do not edit the report yourself: the verifier is the one who ran the checks.`,
      `The report must be a single JSON object with this shape`,
      `("?" marks an optional field; everything else is required):`,
      ``,
      shape,
      ``,
      ...(options.hint ? [options.hint, ``] : []),
      `${maxRepairs - attempt} repair attempt(s) remain before the task is marked FAILED.`,
    ].join("\n"),
  };
}

/**
 * Domain hint for the verification report, consistent with what the engine's
 * validateReport() accepts. An unexecuted check cannot be reported as a
 * failed programmatic check, because that also needs an exit code.
 */
export const VERIFICATION_REPORT_HINT = [
  `For verification_report.json specifically:`,
  `  - "checks" needs at least one entry.`,
  `  - A programmatic or adversarial check records the real "cmd" that ran`,
  `    and its integer "exitCode": "passed": true with 0, false with non-zero.`,
  `  - A check that was not actually run is left out, or recorded as type`,
  `    "rubric" with no cmd or exitCode. Never give it an exit code.`,
  `  - A PASS needs at least one check that actually ran.`,
  `  - "stdoutSha256", if present, is 64 lower-case hex characters.`,
].join("\n");
