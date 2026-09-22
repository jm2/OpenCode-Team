/**
 * The usage observer and the metered budget.
 *
 * Event shapes mirror what opencode 1.18.32 emitted in a real run against a
 * fake OpenAI-compatible server: a primary turn that delegated to a `general`
 * subagent through the task tool, once succeeding and once failing with 400.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.ts";
import { readUsage, seatLeaks, summarize, UsageObserver } from "../src/telemetry.ts";
import { usageReport } from "../src/tools.ts";

let n = 0;
const msg = (over: Record<string, any>) => ({
  type: "message.updated",
  properties: {
    info: {
      id: `msg_${(n += 1)}`,
      role: "assistant",
      sessionID: "root",
      mode: "build",
      providerID: "xiaomi",
      modelID: "mimo-v2.6-pro",
      time: { created: 1, completed: 2 },
      cost: 0.002,
      tokens: { input: 5000, output: 30, reasoning: 5, cache: { read: 0, write: 0 } },
      finish: "stop",
      ...over,
    },
  },
});
const session = (id: string, parentID?: string) => ({
  type: "session.created",
  properties: { info: { id, ...(parentID ? { parentID } : {}) } },
});

function observer(runDir: string | null, telemetryFile?: string) {
  return new UsageObserver({ runDirFor: () => runDir, ...(telemetryFile ? { telemetryFile } : {}) });
}

describe("UsageObserver", () => {
  test("records each finished assistant message once", () => {
    const dir = mkdtempSync(join(tmpdir(), "use-"));
    const o = observer(dir);
    const streaming = msg({ time: { created: 1 } });
    const done = { ...streaming, properties: { info: { ...streaming.properties.info, time: { created: 1, completed: 2 } } } };
    expect(o.onEvent(streaming)).toBeNull(); // still streaming
    expect(o.onEvent(done)).not.toBeNull();
    expect(o.onEvent(done)).toBeNull(); // repeated update
    expect(readUsage(dir).length).toBe(1);
  });

  test("traces a subagent's messages to the root session", () => {
    const o = observer(null);
    o.onEvent(session("root"));
    o.onEvent(session("child", "root"));
    o.onEvent(session("grandchild", "child"));
    const r = o.onEvent(msg({ sessionID: "grandchild", mode: "general" }))!;
    expect(r.parentSessionID).toBe("child");
    expect(r.rootSessionID).toBe("root");
    expect(r.agent).toBe("general");
  });

  test("keeps a provider's error: status and response body", () => {
    const o = observer(null);
    o.onEvent(session("child", "root"));
    const r = o.onEvent(
      msg({
        sessionID: "child",
        mode: "general",
        time: { created: 1 },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: undefined,
        error: {
          name: "APIError",
          data: {
            message: "Param Incorrect: reasoning_content must be passed back",
            statusCode: 400,
            isRetryable: false,
            responseBody: '{"error":{"type":"invalid_request_error"}}',
          },
        },
      }),
    )!;
    expect(r.error).toEqual({
      name: "APIError",
      statusCode: 400,
      message: "Param Incorrect: reasoning_content must be passed back",
      responseBody: '{"error":{"type":"invalid_request_error"}}',
    });
  });

  test("writes the run's usage log, a costs.json summary, and the telemetry file", () => {
    const dir = mkdtempSync(join(tmpdir(), "use-"));
    const tele = join(mkdtempSync(join(tmpdir(), "tele-")), "t.jsonl");
    const o = observer(dir, tele);
    o.onEvent(msg({ cost: 0.25 }));
    o.onEvent(msg({ cost: 0.5, mode: "team/worker" }));
    expect(existsSync(join(dir, "usage.jsonl"))).toBe(true);
    const costs = JSON.parse(readFileSync(join(dir, "costs.json"), "utf-8"));
    expect(costs.messages).toBe(2);
    expect(costs.costUsd).toBeCloseTo(0.75, 10);
    expect(costs.note).toContain("provider-reported");
    expect(readFileSync(tele, "utf-8").trim().split("\n").length).toBe(2);
  });

  test("ignores user messages and non-message events", () => {
    const o = observer(null);
    expect(o.onEvent({ type: "message.updated", properties: { info: { role: "user", id: "u1" } } })).toBeNull();
    expect(o.onEvent({ type: "session.idle", properties: {} })).toBeNull();
  });
});

describe("summaries", () => {
  const recs = () => {
    const o = observer(null);
    o.onEvent(session("root"));
    o.onEvent(session("w", "root"));
    return [
      o.onEvent(msg({ mode: "team/sentinel" }))!,
      o.onEvent(msg({ sessionID: "w", mode: "team/worker" }))!,
      o.onEvent(msg({ sessionID: "w", mode: "team/worker", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }))!,
      o.onEvent(msg({ mode: "title", providerID: "fake", modelID: "small" }))!,
    ];
  };

  test("counts reasoning per seat, so non-uniform thinking is visible", () => {
    const s = summarize(recs());
    expect(s.byAgent["team/worker"]).toMatchObject({ messages: 2, withReasoning: 1 });
    expect(s.subagentMessages).toBe(2);
  });

  test("a seat on another model is a leak; opencode's title agent is not a seat", () => {
    const s = summarize(recs());
    expect(seatLeaks(s, "xiaomi/mimo-v2.6-pro")).toEqual([]);
    const leaky = summarize([...recs(), observer(null).onEvent(msg({ mode: "team/scout", providerID: "anthropic", modelID: "claude-haiku-4-5" }))!]);
    expect(seatLeaks(leaky, "xiaomi/mimo-v2.6-pro")).toEqual([{ agent: "team/scout", model: "anthropic/claude-haiku-4-5" }]);
  });

  test("usageReport says it plainly", () => {
    const dir = mkdtempSync(join(tmpdir(), "use-"));
    const o = observer(dir);
    o.onEvent(msg({ mode: "team/sentinel" }));
    o.onEvent(msg({ mode: "team/scout", providerID: "anthropic", modelID: "claude-haiku-4-5" }));
    const text = usageReport(dir, "xiaomi/mimo-v2.6-pro").join("\n");
    expect(text).toContain("SEAT LEAK: team/scout ran on anthropic/claude-haiku-4-5");
    expect(usageReport(mkdtempSync(join(tmpdir(), "e-")), "x/y")[0]).toContain("nothing metered");
  });
});

describe("the metered budget", () => {
  const failing = (id: string) => ({
    taskId: id,
    verifierAgent: "v",
    verifierModel: "m",
    timestamp: "t",
    status: "FAIL" as const,
    checks: [{ name: "c", type: "programmatic" as const, passed: false, cmd: "x", exitCode: 1 }],
    feedbackForWorker: "",
  });

  function run(budgetUsd: number) {
    const runDir = join(mkdtempSync(join(tmpdir(), "bud-")), "run");
    const e = Engine.create({ runDir, sessionId: "s", topology: "small-focused", tasks: [{ taskId: "t", title: "t", maxRounds: 99 }], budgetUsd });
    return { e, runDir };
  }

  test("stops dispatch on metered cost when the sentinel reports none", () => {
    // Before metering: 25 rounds against a $0.01 cap left cost at $0.00 and
    // dispatch never stopped, because nothing reported a cost.
    const { e, runDir } = run(0.01);
    const o = observer(runDir);
    for (let i = 0; i < 25; i += 1) {
      o.onEvent(msg({ cost: 0.001 }));
      e.recordRound({ taskId: "t", report: failing("t") });
    }
    expect(e.status().costSource).toBe("metered");
    expect(e.status().costUsd).toBeCloseTo(0.025, 10);
    expect(e.status().reportedCostUsd).toBe(0);
    expect(e.budgetExhausted()).toBe(true);
    expect(e.dispatchable(5)).toEqual([]);
    const exhausted = e.events().find((ev) => ev.type === "budget.exhausted")!;
    expect(exhausted.data).toMatchObject({ costSource: "metered" });
  });

  test("a model-reported figure no longer drives the budget once usage is metered", () => {
    const { e, runDir } = run(1);
    observer(runDir).onEvent(msg({ cost: 0.01 }));
    e.recordRound({ taskId: "t", report: failing("t"), costUsd: 50 });
    expect(e.status().costUsd).toBeCloseTo(0.01, 10);
    expect(e.status().reportedCostUsd).toBe(50);
    expect(e.budgetExhausted()).toBe(false);
  });

  test("falls back to the reported figure when nothing is metered", () => {
    const { e } = run(1);
    e.recordRound({ taskId: "t", report: failing("t"), costUsd: 2 });
    expect(e.status().costSource).toBe("reported");
    expect(e.budgetExhausted()).toBe(true);
  });

  test("--no-budget still disables it", () => {
    const runDir = join(mkdtempSync(join(tmpdir(), "bud-")), "run");
    const e = Engine.create({ runDir, sessionId: "s", topology: "small-focused", tasks: [{ taskId: "t", title: "t" }], budgetUsd: 0.01, budgetEnforced: false });
    observer(runDir).onEvent(msg({ cost: 5 }));
    expect(e.budgetExhausted()).toBe(false);
    expect(e.dispatchable(5).length).toBe(1);
  });
});
