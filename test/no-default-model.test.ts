/**
 * The plugin must not choose a model for the user.
 *
 * Every agent template carried `model: anthropic/claude-sonnet-4-5`, and the
 * loader fell back to the same string. Any team/* agent the user had not
 * configured explicitly ran on Claude Sonnet, overriding their default model
 * — and for anyone without Anthropic credentials, /teamwork failed outright
 * with "Model not found: anthropic/claude-sonnet-4-5" (observed with
 * opencode 1.18.32).
 */

import { describe, expect, test } from "bun:test";
import { AGENT_TEMPLATES, agentConfigs } from "../src/templates.ts";

describe("agent models", () => {
  test("no template names a model", () => {
    for (const a of AGENT_TEMPLATES) expect({ agent: a.name, model: a.model }).toEqual({ agent: a.name, model: undefined });
  });

  test("an unconfigured agent gets no model, so opencode uses the user's default", () => {
    for (const [name, cfg] of Object.entries(agentConfigs({}))) {
      expect({ name, model: cfg.model }).toEqual({ name, model: undefined });
    }
  });

  test("a model the user or installer set is kept", () => {
    const cfgs = agentConfigs({ "team/worker": { model: "google/gemini-3-flash" } });
    expect(cfgs["team/worker"]!.model).toBe("google/gemini-3-flash");
    expect(cfgs["team/sentinel"]!.model).toBeUndefined();
  });
});
