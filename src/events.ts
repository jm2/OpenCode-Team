/**
 * Append-only, hash-chained run event log.
 *
 * This is the source of truth for a Teamwork run. `state.json` is now a
 * DERIVED snapshot (see deriveSession) — the LLM never owns the record of
 * what happened, because an LLM-written snapshot can silently skip or
 * misreport transitions.
 *
 * Properties:
 *   - append-only: events are never rewritten, only appended
 *   - tamper-evident: each event carries prevHash + hash (sha256 over the
 *     canonical JSON of the event with its hash removed)
 *   - replayable: deriveSession(events) reconstructs the run state, so a
 *     crashed/resumed run can be rebuilt from disk
 *
 * One event per line, JSONL. `events.jsonl` lives in the run directory
 * (`.opencode/teamwork/<session-id>/`).
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export const GENESIS_HASH = "0".repeat(64);

export type EventType =
  | "session.start"
  | "plan.written"
  | "worktree.created"
  | "task.dispatched"
  | "task.round"
  | "verification.report"
  | "task.completed"
  | "task.failed"
  | "task.deadletter"
  | "budget.warning"
  | "budget.exhausted"
  | "session.done"
  | "session.error";

export interface RunEvent {
  seq: number;
  ts: string;
  type: EventType;
  sessionId: string;
  taskId?: string;
  data?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface TaskDerived {
  taskId: string;
  title: string;
  status: "PENDING" | "DISPATCHED" | "VERIFYING" | "COMPLETED" | "FAILED" | "DEADLETTER";
  attempts: number;
  costUsd: number;
  dependsOn: string[];
  lastReport?: Record<string, unknown>;
}

export interface DerivedSession {
  sessionId: string;
  topology?: string;
  state: "PENDING" | "RUNNING" | "DONE" | "ERROR";
  tasks: Record<string, TaskDerived>;
  order: string[];
  budgetUsd: number;
  haltAtPct: number;
  costUsd: number;
  rounds: number;
  deadletter: string[];
  lastSeq: number;
  tipHash: string;
}

/**
 * Cached tip per log file, so a burst of appends does not re-read the whole
 * file each time.
 *
 * The cached entry carries the file size and mtime it was valid for. Without that check
 * the cache outranked the file: if anything else changed the log — a second
 * process, a restore from backup, an operator editing it — `appendEvent` went
 * on building from the remembered tip, writing a duplicate `seq` and a
 * `prevHash` pointing at an event that was no longer last. That produces a
 * chain which `verifyChain` then reports as corrupt, with the append that
 * caused it looking innocent.
 */
interface CachedTip {
  event: RunEvent;
  stamp: string;
}

const TIP_CACHE = new Map<string, CachedTip>();

/** Drop a cached tip. Exported for tests and for callers that know the log
 *  changed underneath them. */
export function forgetTip(runDir: string): void {
  TIP_CACHE.delete(eventLogPath(runDir));
}

export function eventLogPath(runDir: string): string {
  return join(runDir, "events.jsonl");
}

/** Canonical JSON: keys sorted, so the hash is stable across engines. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function hashEvent(prevHash: string, event: Omit<RunEvent, "hash">): string {
  return createHash("sha256").update(`${prevHash}\n${canonical(event)}`).digest("hex");
}

/** Size plus modification time: cheap, and changes whenever the file does. */
function fileStamp(path: string): string | null {
  try {
    const st = statSync(path);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

function readTip(runDir: string): RunEvent | null {
  const path = eventLogPath(runDir);
  const stamp = fileStamp(path);
  if (stamp === null) {
    // The log is gone. A remembered tip would resurrect a chain that no
    // longer exists on disk.
    TIP_CACHE.delete(path);
    return null;
  }

  const cached = TIP_CACHE.get(path);
  if (cached && cached.stamp === stamp) return cached.event;

  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1];
  if (!last) {
    TIP_CACHE.delete(path);
    return null;
  }
  const parsed = JSON.parse(last) as RunEvent;
  TIP_CACHE.set(path, { event: parsed, stamp });
  return parsed;
}

export interface AppendInput {
  type: EventType;
  sessionId: string;
  taskId?: string;
  data?: Record<string, unknown>;
  ts?: string;
}

/**
 * Append one event and return it (with seq/prevHash/hash filled in).
 * Sequential by construction: the hash chain is built from the previous
 * event's hash, so two concurrent appends to the same run must be
 * serialized by the caller (the Engine does this — it is single-writer
 * per run, which is also why only one process may own a run directory).
 */
/**
 * Refuse to append after a partial line.
 *
 * Appending to a file that does not end in a newline glues the new event onto
 * the fragment, so one damaged line becomes a damaged line that also swallows
 * the next event. Checked from the file's last byte rather than the cached
 * tip, because a cached tip does not know the file was cut short.
 */
function assertAppendable(runDir: string): void {
  const path = eventLogPath(runDir);
  if (!existsSync(path)) return;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    if (last.toString("utf-8") === "\n") return;
  } finally {
    closeSync(fd);
  }
  const damage = describeLogDamage(readEventLog(runDir)) ?? "the file does not end with a newline";
  throw new Error(`refusing to append to ${path}: ${damage}`);
}

export function appendEvent(runDir: string, input: AppendInput): RunEvent {
  mkdirSync(runDir, { recursive: true });
  assertAppendable(runDir);
  const tip = readTip(runDir);
  const prevHash = tip?.hash ?? GENESIS_HASH;
  const seq = (tip?.seq ?? 0) + 1;

  const draft: Omit<RunEvent, "hash"> = {
    seq,
    ts: input.ts ?? new Date().toISOString(),
    type: input.type,
    sessionId: input.sessionId,
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.data !== undefined ? { data: input.data } : {}),
    prevHash,
  };
  const event: RunEvent = { ...draft, hash: hashEvent(prevHash, draft) };
  const path = eventLogPath(runDir);
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf-8");
  const stamp = fileStamp(path);
  if (stamp === null) TIP_CACHE.delete(path);
  else TIP_CACHE.set(path, { event, stamp });
  return event;
}

export interface LogReadResult {
  /** Every event up to the first unparseable line. */
  events: RunEvent[];
  /** 1-based line number of the first unparseable line, if there is one. */
  malformedAtLine?: number;
  malformedReason?: string;
  /**
   * True when the bad line is the last line in the file: the signature of a
   * process killed mid-append. False means intact lines follow it, which a
   * crash cannot produce.
   */
  malformedIsLast?: boolean;
}

/** One sentence describing the damage, shared by every caller that reports it. */
export function describeLogDamage(log: LogReadResult): string | null {
  if (log.malformedAtLine === undefined) return null;
  const where = `line ${log.malformedAtLine} of events.jsonl is not valid JSON (${log.malformedReason})`;
  const intact = `${log.events.length} event(s) before it are intact`;
  return log.malformedIsLast
    ? `${where}. It is the last line, which is what a run killed mid-append leaves behind; ${intact}.`
    : `${where}, and valid lines follow it. A crash cannot produce that; the file was edited or damaged. ${intact}.`;
}

/**
 * Read the log, stopping at the first line that will not parse.
 *
 * A run that is killed mid-append, or that runs out of disk, leaves a partial
 * final line. Parsing the whole file eagerly turned that into a thrown
 * SyntaxError from every caller — including `teamwork_resume`, whose entire
 * job is to detect and report a damaged log. The tool could not read far
 * enough to say what was wrong.
 *
 * Truncation is reported rather than skipped: silently dropping a bad line
 * would let a damaged log look healthy, which is the failure this log format
 * exists to prevent.
 */
export function readEventLog(runDir: string): LogReadResult {
  const path = eventLogPath(runDir);
  if (!existsSync(path)) return { events: [] };

  const events: RunEvent[] = [];
  const lines = readFileSync(path, "utf-8").split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line) as RunEvent);
    } catch (err) {
      const rest = lines.slice(i + 1).some((l) => l.trim().length > 0);
      return {
        events,
        malformedAtLine: i + 1,
        malformedReason: (err as Error).message,
        malformedIsLast: !rest,
      };
    }
  }
  return { events };
}

export function readEvents(runDir: string): RunEvent[] {
  return readEventLog(runDir).events;
}

export interface ChainCheck {
  ok: boolean;
  brokenAt?: number;
  reason?: string;
  length: number;
  tipHash: string;
}

/** Verify the hash chain end to end. A broken chain means the log was edited. */
export function verifyChain(events: RunEvent[]): ChainCheck {
  let prev = GENESIS_HASH;
  let seq = 0;
  for (const ev of events) {
    seq += 1;
    if (ev.seq !== seq) {
      return { ok: false, brokenAt: ev.seq, reason: `expected seq ${seq}, found ${ev.seq}`, length: events.length, tipHash: prev };
    }
    if (ev.prevHash !== prev) {
      return { ok: false, brokenAt: ev.seq, reason: "prevHash does not match the previous event", length: events.length, tipHash: prev };
    }
    const { hash, ...rest } = ev;
    const expect = hashEvent(prev, rest as Omit<RunEvent, "hash">);
    if (expect !== hash) {
      return { ok: false, brokenAt: ev.seq, reason: "hash mismatch (event was modified)", length: events.length, tipHash: prev };
    }
    prev = hash;
  }
  const tip = events[events.length - 1];
  return { ok: true, length: events.length, tipHash: tip?.hash ?? GENESIS_HASH };
}

/**
 * Replay the log into run state. This is what the sentinel, the CLI and
 * the TUI all read — never `state.json`.
 */
export function deriveSession(events: RunEvent[]): DerivedSession {
  const first = events[0];
  const sessionId = first?.sessionId ?? "";
  const tasks: Record<string, TaskDerived> = {};
  const order: string[] = [];
  let topology: string | undefined;
  let budgetUsd = 0;
  let haltAtPct = 80;
  let costUsd = 0;
  let rounds = 0;
  let state: DerivedSession["state"] = "PENDING";

  const ensure = (taskId: string): TaskDerived => {
    const existing = tasks[taskId];
    if (existing) return existing;
    const created: TaskDerived = {
      taskId,
      title: taskId,
      status: "PENDING",
      attempts: 0,
      costUsd: 0,
      dependsOn: [],
    };
    tasks[taskId] = created;
    order.push(taskId);
    return created;
  };

  for (const ev of events) {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    switch (ev.type) {
      case "session.start":
        state = "RUNNING";
        if (typeof d.topology === "string") topology = d.topology;
        if (typeof d.budgetUsd === "number") budgetUsd = d.budgetUsd;
        if (typeof d.haltAtPct === "number") haltAtPct = d.haltAtPct;
        break;
      case "plan.written": {
        const raw = d.tasks;
        if (Array.isArray(raw)) {
          for (const t of raw as Array<Record<string, unknown>>) {
            const id = String(t.taskId ?? "");
            if (!id) continue;
            const task = ensure(id);
            if (typeof t.title === "string") task.title = t.title;
            task.dependsOn = Array.isArray(t.dependsOn) ? (t.dependsOn as string[]) : [];
          }
        }
        break;
      }
      case "task.dispatched": {
        if (!ev.taskId) break;
        const task = ensure(ev.taskId);
        task.status = "DISPATCHED";
        break;
      }
      case "verification.report": {
        // A round is one verifier verdict. `task.round` is an informational
        // follow-up on the same round, so it must not be counted again.
        if (!ev.taskId) break;
        const task = ensure(ev.taskId);
        rounds += 1;
        if (typeof d.costUsd === "number") {
          task.costUsd += d.costUsd;
          costUsd += d.costUsd;
        }
        if (typeof d.attempt === "number") task.attempts = d.attempt;
        if (d.report && typeof d.report === "object") {
          task.lastReport = d.report as Record<string, unknown>;
        }
        task.status = "VERIFYING";
        break;
      }
      case "task.round": {
        if (!ev.taskId) break;
        const task = ensure(ev.taskId);
        if (typeof d.attempt === "number") task.attempts = d.attempt;
        task.status = "PENDING";
        break;
      }
      case "task.completed":
        if (ev.taskId) ensure(ev.taskId).status = "COMPLETED";
        break;
      case "task.failed":
        if (ev.taskId) ensure(ev.taskId).status = "FAILED";
        break;
      case "task.deadletter":
        if (ev.taskId) ensure(ev.taskId).status = "DEADLETTER";
        break;
      case "budget.exhausted":
        if (typeof d.costUsd === "number") costUsd = Math.max(costUsd, d.costUsd);
        break;
      case "session.done":
        state = "DONE";
        break;
      case "session.error":
        state = "ERROR";
        break;
      default:
        break;
    }
  }

  const deadletter = order.filter((id) => tasks[id]?.status === "DEADLETTER");
  const tip = events[events.length - 1];
  return {
    sessionId,
    ...(topology ? { topology } : {}),
    state,
    tasks,
    order,
    budgetUsd,
    haltAtPct,
    costUsd,
    rounds,
    deadletter,
    lastSeq: tip?.seq ?? 0,
    tipHash: tip?.hash ?? GENESIS_HASH,
  };
}

/** Write the derived snapshot. Derived data only — never hand-edited. */
export function writeSnapshot(runDir: string, derived: DerivedSession): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "state.json"),
    `${JSON.stringify(derived, null, 2)}\n`,
    "utf-8",
  );
}

/** Test/resume helper: forget the cached tip so the file is re-read. */
export function resetTipCache(): void {
  TIP_CACHE.clear();
}
