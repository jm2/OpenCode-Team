#!/usr/bin/env bun
/**
 * A scriptable OpenAI-compatible chat server, for driving a real opencode
 * install end to end without a provider account.
 *
 * It streams /v1/chat/completions the way @ai-sdk/openai-compatible expects,
 * reports usage (including reasoning tokens) in the final chunk, can emit
 * tool calls, and can fail a request with any HTTP status. Behaviour comes
 * from a JSON rules file, first match wins:
 *
 *   { "rules": [
 *       { "when": { "user": "regex on the latest user text",
 *                   "tool": "regex on the latest tool result",
 *                   "system": "regex on the system prompt",
 *                   "afterTool": true },
 *         "then": { "text": "reply", "reasoning": "optional thinking",
 *                   "tool": { "name": "write", "args": { "filePath": "$1" } },
 *                   "status": 400, "error": "message" } } ] }
 *
 * "$1".."$9" in text or tool args are replaced with capture groups from the
 * `tool` regex if it has any, else the `user` regex. With no matching rule: title requests get a short title, a
 * turn that follows a tool result echoes that result, anything else gets "ok".
 *
 *   FAKE_RULES=rules.json FAKE_PORT=18555 FAKE_LOG=requests.jsonl bun scripts/fake-model-server.ts
 */

import { appendFileSync, readFileSync } from "node:fs";

interface Rule {
  when?: { user?: string; tool?: string; system?: string; afterTool?: boolean };
  then: {
    text?: string;
    reasoning?: string;
    tool?: { name: string; args: Record<string, unknown> };
    status?: number;
    error?: string;
  };
}

const rulesPath = process.env.FAKE_RULES;
const rules: Rule[] = rulesPath ? (JSON.parse(readFileSync(rulesPath, "utf-8")).rules ?? []) : [];
const LOG = process.env.FAKE_LOG;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
  return "";
}

function substitute(value: unknown, groups: string[]): unknown {
  if (typeof value === "string") return value.replace(/\$(\d)/g, (_, n) => groups[Number(n)] ?? "");
  if (Array.isArray(value)) return value.map((v) => substitute(v, groups));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, groups)]));
  }
  return value;
}

const tokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));
let calls = 0;

Bun.serve({
  port: Number(process.env.FAKE_PORT ?? 0),
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
    const body = (await req.json().catch(() => ({}))) as any;
    const messages: any[] = body.messages ?? [];
    const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const user = lastUser ? textOf(lastUser.content) : "";
    const last = messages[messages.length - 1];
    const afterTool = last?.role === "tool";
    const toolResult = afterTool ? textOf(last.content) : "";

    let chosen: Rule["then"] | undefined;
    let groups: string[] = [];
    // opencode's title generator quotes the user's first message, so it would
    // match user rules meant for the conversation. Answer it first.
    const isTitle = /title generator/i.test(system);
    if (isTitle) chosen = { text: "Test session" };
    for (const rule of isTitle ? [] : rules) {
      const w = rule.when ?? {};
      if (w.afterTool !== undefined && w.afterTool !== afterTool) continue;
      if (w.system && !new RegExp(w.system, "s").test(system)) continue;
      let captured: string[] = [];
      if (w.user) {
        const m = new RegExp(w.user, "s").exec(user);
        if (!m) continue;
        captured = [...m];
      }
      if (w.tool) {
        if (!afterTool) continue;
        const m = new RegExp(w.tool, "s").exec(toolResult);
        if (!m) continue;
        if (m.length > 1) captured = [...m];
      }
      groups = captured;
      chosen = rule.then;
      break;
    }
    if (!chosen) {
      if (afterTool) chosen = { text: `DONE: ${toolResult.slice(0, 400)}` };
      else chosen = { text: "ok" };
    }
    calls += 1;
    if (LOG) {
      appendFileSync(
        LOG,
        `${JSON.stringify({ n: calls, user: user.slice(0, 200), afterTool, tools: (body.tools ?? []).length, reply: chosen })}\n`,
      );
    }

    if (chosen.status && chosen.status >= 400) {
      return Response.json(
        { error: { message: chosen.error ?? "rejected by fake server", type: "invalid_request_error" } },
        { status: chosen.status },
      );
    }

    const then = substitute(chosen, groups) as Rule["then"];
    const id = `chatcmpl-${calls}`;
    const chunk = (o: unknown) =>
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: body.model ?? "fake", ...(o as object) })}\n\n`;
    const out: string[] = [];
    if (then.reasoning) {
      out.push(chunk({ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: then.reasoning }, finish_reason: null }] }));
    }
    if (then.text) out.push(chunk({ choices: [{ index: 0, delta: { role: "assistant", content: then.text }, finish_reason: null }] }));
    if (then.tool) {
      out.push(
        chunk({
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  { index: 0, id: `call_${calls}`, type: "function", function: { name: then.tool.name, arguments: JSON.stringify(then.tool.args) } },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      );
    }
    const prompt = tokens(JSON.stringify(messages));
    const reasoningTokens = then.reasoning ? tokens(then.reasoning) : 0;
    const completion = tokens((then.text ?? "") + JSON.stringify(then.tool ?? "")) + reasoningTokens;
    out.push(
      chunk({
        choices: [{ index: 0, delta: {}, finish_reason: then.tool ? "tool_calls" : "stop" }],
        usage: {
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: prompt + completion,
          completion_tokens_details: { reasoning_tokens: reasoningTokens },
        },
      }),
    );
    out.push("data: [DONE]\n\n");
    return new Response(out.join(""), { headers: { "content-type": "text/event-stream" } });
  },
});

console.log(`fake model server on 127.0.0.1:${process.env.FAKE_PORT ?? "?"}`);
