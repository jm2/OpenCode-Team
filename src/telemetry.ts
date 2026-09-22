/**
 * Usage observer: what each seat actually ran on and actually consumed.
 *
 * opencode records, on every assistant message, the provider-reported token
 * counts, a cost it computes from its model catalog, the provider and model
 * that served it, the agent that sent it, and — when the call failed — a
 * structured error with the HTTP status. Sessions record their parent, so a
 * subagent's messages can be traced to the run that spawned it. This module
 * turns those events into records, so that:
 *
 *   - the budget is driven by metered usage, not by a figure the
 *     orchestrating model types into teamwork_verify;
 *   - a run can prove every seat was served by the pinned model;
 *   - reasoning can be seen to be on, or off, uniformly across seats;
 *   - a subagent's provider error (the HTTP 400 delegation failure) is
 *     recorded with its status and response body instead of vanishing.
 *
 * Nothing here changes what any agent does. It only watches.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface UsageRecord {
  ts: string;
  messageID: string;
  sessionID: string;
  /** Set when this message came from a subagent session. */
  parentSessionID?: string;
  rootSessionID: string;
  agent: string;
  model: string;
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  /** opencode's cost: catalog price x provider-reported tokens. */
  costUsd: number;
  finish?: string;
  error?: { name: string; statusCode?: number; message?: string; responseBody?: string };
}

export interface UsageSummary {
  messages: number;
  costUsd: number;
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  byModel: Record<string, { messages: number; costUsd: number }>;
  byAgent: Record<string, { messages: number; costUsd: number; withReasoning: number; reasoningTokens: number; models: string[] }>;
  subagentMessages: number;
  errors: Array<{ agent: string; model: string; name: string; statusCode?: number; message?: string; subagent: boolean }>;
}

export const TELEMETRY_ENV = "TEAMWORK_TELEMETRY_FILE";
export const USAGE_FILE = "usage.jsonl";
export const COSTS_FILE = "costs.json";

/**
 * Written message ids, module-wide. opencode de-duplicates plugin exports
 * by identity, but if two instances of this module's plugin were ever live,
 * they must not double-count a message.
 */
const written = new Set<string>();

type AnyEvent = { type?: string; properties?: Record<string, any> };

export class UsageObserver {
  private readonly parents = new Map<string, string | undefined>();

  constructor(
    private readonly opts: {
      /** Run directory for a root opencode session, if it belongs to a run. */
      runDirFor: (rootSessionID: string) => string | null;
      telemetryFile?: string;
      now?: () => string;
    },
  ) {}

  /** Walk parent links to the session that started this tree. */
  rootOf(sessionID: string): string {
    let id = sessionID;
    for (let i = 0; i < 64; i += 1) {
      const parent = this.parents.get(id);
      if (!parent) return id;
      id = parent;
    }
    return id;
  }

  onEvent(event: AnyEvent): UsageRecord | null {
    const info = event.properties?.info;
    if ((event.type === "session.created" || event.type === "session.updated") && info?.id) {
      this.parents.set(info.id, info.parentID || undefined);
      return null;
    }
    if (event.type !== "message.updated" || !info || info.role !== "assistant") return null;
    // Streaming updates repeat; record once, when the message is final.
    if (!info.time?.completed && !info.error) return null;
    if (written.has(info.id)) return null;
    written.add(info.id);

    const record = toRecord(info, this.parents.get(info.sessionID), this.rootOf(info.sessionID), this.opts.now);
    const runDir = this.opts.runDirFor(record.rootSessionID);
    if (runDir) appendUsage(runDir, record);
    if (this.opts.telemetryFile) appendLine(this.opts.telemetryFile, record);
    return record;
  }
}

function toRecord(info: any, parent: string | undefined, root: string, now?: () => string): UsageRecord {
  const t = info.tokens ?? {};
  const err = info.error;
  return {
    ts: now ? now() : new Date().toISOString(),
    messageID: String(info.id),
    sessionID: String(info.sessionID),
    ...(parent ? { parentSessionID: parent } : {}),
    rootSessionID: root,
    agent: String(info.mode ?? info.agent ?? "unknown"),
    model: `${info.providerID}/${info.modelID}`,
    tokens: {
      input: num(t.input),
      output: num(t.output),
      reasoning: num(t.reasoning),
      cacheRead: num(t.cache?.read),
      cacheWrite: num(t.cache?.write),
    },
    costUsd: num(info.cost),
    ...(info.finish ? { finish: String(info.finish) } : {}),
    ...(err
      ? {
          error: {
            name: String(err.name ?? "Error"),
            ...(typeof err.data?.statusCode === "number" ? { statusCode: err.data.statusCode } : {}),
            ...(err.data?.message ? { message: String(err.data.message).slice(0, 500) } : {}),
            ...(err.data?.responseBody ? { responseBody: String(err.data.responseBody).slice(0, 2000) } : {}),
          },
        }
      : {}),
  };
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function appendLine(path: string, record: UsageRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
}

/** Append to the run's usage log and refresh its costs.json summary. */
export function appendUsage(runDir: string, record: UsageRecord): void {
  appendLine(join(runDir, USAGE_FILE), record);
  const summary = summarize(readUsage(runDir));
  writeFileSync(
    join(runDir, COSTS_FILE),
    `${JSON.stringify(
      {
        note:
          "Metered by opencode: tokens are provider-reported; costUsd is opencode's catalog price times those tokens. On a subscription plan the dollar figure is notional; the tokens are not.",
        ...summary,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

export function readUsage(runDir: string): UsageRecord[] {
  const path = join(runDir, USAGE_FILE);
  if (!existsSync(path)) return [];
  const out: UsageRecord[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as UsageRecord);
    } catch {
      // A torn final line from a crash is skipped; the rest still counts.
    }
  }
  return out;
}

export function summarize(records: UsageRecord[]): UsageSummary {
  const s: UsageSummary = {
    messages: 0,
    costUsd: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    byModel: {},
    byAgent: {},
    subagentMessages: 0,
    errors: [],
  };
  for (const r of records) {
    s.messages += 1;
    s.costUsd += r.costUsd;
    for (const k of Object.keys(s.tokens) as Array<keyof UsageSummary["tokens"]>) s.tokens[k] += r.tokens[k];
    const m = (s.byModel[r.model] ??= { messages: 0, costUsd: 0 });
    m.messages += 1;
    m.costUsd += r.costUsd;
    const a = (s.byAgent[r.agent] ??= { messages: 0, costUsd: 0, withReasoning: 0, reasoningTokens: 0, models: [] });
    a.messages += 1;
    a.costUsd += r.costUsd;
    if (r.tokens.reasoning > 0) a.withReasoning += 1;
    a.reasoningTokens += r.tokens.reasoning;
    if (!a.models.includes(r.model)) a.models.push(r.model);
    if (r.parentSessionID) s.subagentMessages += 1;
    if (r.error) {
      s.errors.push({
        agent: r.agent,
        model: r.model,
        name: r.error.name,
        ...(r.error.statusCode !== undefined ? { statusCode: r.error.statusCode } : {}),
        ...(r.error.message ? { message: r.error.message } : {}),
        subagent: !!r.parentSessionID,
      });
    }
  }
  return s;
}

/** opencode's own background agents: they run on `small_model`, not a seat. */
export const INTERNAL_AGENTS = ["title", "summary", "compaction"];

/**
 * Seats that ran on something other than the pinned model. Empty is the
 * single-model guarantee holding at runtime, not just in the config file.
 */
export function seatLeaks(summary: UsageSummary, pinned: string): Array<{ agent: string; model: string }> {
  const leaks: Array<{ agent: string; model: string }> = [];
  for (const [agent, a] of Object.entries(summary.byAgent)) {
    if (INTERNAL_AGENTS.includes(agent)) continue;
    for (const model of a.models) {
      if (model.toLowerCase() !== pinned.toLowerCase()) leaks.push({ agent, model });
    }
  }
  return leaks;
}
