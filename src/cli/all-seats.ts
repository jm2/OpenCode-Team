/**
 * Single-model seat assignment.
 *
 * Additive module for running every Teamwork role on one model, so a run can
 * isolate whether the propose → falsify → synthesize → verify loop adds value
 * independent of model diversity.
 *
 * Nothing here routes, proxies or synthesizes a model id. `allSeatsAgents`
 * writes the caller's literal string into every seat; `resolveConfiguredModel`
 * reads an id that already exists in the user's opencode config. The plugin's
 * "dispatch and don't care which model a role uses" contract is untouched.
 */

/**
 * Every role the installer writes a model for.
 *
 * Canonical here rather than in the CLI entry point so tests and the plugin
 * can import the roster without executing `main()`.
 */
export const TEAM_ROLES = [
  "team/crafter",
  "team/sentinel",
  "team/worker",
  "team/proof-worker",
  "team/verifier",
  "team/orchestrator",
  "team/proposer",
  "team/falsifier",
  "team/synthesizer",
  "team/scout",
] as const;

/** Provider prefixes whose presence in an emitted patch would invalidate a
 *  single-model baseline. Checked by `findVendorModelStrings`. */
export const VENDOR_MODEL_PREFIXES = [
  "anthropic/",
  "openai/",
  "google/",
  "openrouter/",
  "azure/",
  "bedrock/",
  "vertex/",
  "mistral/",
  "meta/",
  "cohere/",
  "deepseek/",
  "xai/",
] as const;

/** Bare family names that betray a vendor default even without a prefix. */
const VENDOR_MODEL_SUBSTRINGS = [
  "claude-",
  "gpt-",
  "gemini-",
  "llama-",
  "o1-",
  "o3-",
  "grok-",
  "mixtral",
] as const;

/**
 * Walk any JSON-ish value and report every string that looks like a vendor
 * model id, with its path. An empty array is the assertion Phase 1 needs:
 * no vendor default leaked into any seat.
 *
 * `allow` is the one id that is legitimately present — the model being pinned.
 * It is compared case-insensitively and exactly, so a seat holding the pinned
 * model never reports, while a seat holding anything else does.
 */
export function findVendorModelStrings(
  value: unknown,
  allow?: string,
  path = "",
): Array<{ path: string; value: string }> {
  const hits: Array<{ path: string; value: string }> = [];
  const allowed = allow?.toLowerCase();

  const walk = (node: unknown, at: string): void => {
    if (typeof node === "string") {
      const lower = node.toLowerCase();
      if (allowed && lower === allowed) return;
      const looksVendor =
        VENDOR_MODEL_PREFIXES.some((p) => lower.startsWith(p)) ||
        VENDOR_MODEL_SUBSTRINGS.some((s) => lower.includes(s));
      if (looksVendor) hits.push({ path: at || "(root)", value: node });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${at}[${i}]`));
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        walk(v, at ? `${at}.${k}` : k);
      }
    }
  };

  walk(value, path);
  return hits;
}

/**
 * Assign one model id to every supplied role.
 *
 * `roles` is passed in rather than imported so this module stays free of a
 * cycle with the CLI. The caller owns the roster; this owns the invariant that
 * every member of it gets the same string, verbatim.
 */
export function allSeatsAgents(roles: readonly string[], modelId: string): Record<string, string> {
  const id = modelId.trim();
  if (!id) throw new Error("--all-seats needs a model id, e.g. --all-seats xiaomi/mimo-v2.6-pro");
  if (/\s/.test(id)) throw new Error(`model id must not contain whitespace: "${modelId}"`);
  const out: Record<string, string> = {};
  for (const role of roles) out[role] = id;
  return out;
}

// ─── Resolving a configured model out of opencode.json ───────────────

export interface ResolvedProviderModel {
  /** `<providerKey>/<modelKey>`, exactly as opencode matches it. */
  modelId: string;
  providerKey: string;
  modelKey: string;
  /** Display name from the model entry, when present. */
  displayName?: string;
  /** The provider's `npm` package — this is what decides the wire protocol. */
  npm?: string;
  baseURL?: string;
  /** Provider-level reasoning/thinking flags found on the model entry. */
  reasoning?: boolean;
}

/** OpenAI vs Anthropic, inferred from the provider's npm package. */
export function protocolFor(npm: string | undefined): "openai" | "anthropic" | "unknown" {
  if (!npm) return "unknown";
  const p = npm.toLowerCase();
  if (p.includes("anthropic")) return "anthropic";
  if (p.includes("openai")) return "openai";
  return "unknown";
}

/**
 * Find a provider's models in an opencode config.
 *
 * Returns every `<provider>/<model>` pair whose provider key or model key
 * matches `match`. The caller decides what to do with 0, 1 or many — this
 * never picks for you, because guessing a model id is exactly the failure
 * mode this function exists to prevent.
 */
export function findConfiguredModels(
  config: Record<string, any>,
  match: RegExp,
): ResolvedProviderModel[] {
  const out: ResolvedProviderModel[] = [];
  const providers = config?.provider;
  if (!providers || typeof providers !== "object") return out;

  for (const [providerKey, providerRaw] of Object.entries(providers)) {
    const provider = providerRaw as Record<string, any>;
    if (!provider || typeof provider !== "object") continue;
    const models = provider.models;
    if (!models || typeof models !== "object") continue;

    for (const [modelKey, modelRaw] of Object.entries(models)) {
      const model = (modelRaw ?? {}) as Record<string, any>;
      const id = `${providerKey}/${modelKey}`;
      if (!match.test(providerKey) && !match.test(modelKey) && !match.test(String(model.name ?? ""))) {
        continue;
      }
      out.push({
        modelId: id,
        providerKey,
        modelKey,
        ...(typeof model.name === "string" ? { displayName: model.name } : {}),
        ...(typeof provider.npm === "string" ? { npm: provider.npm } : {}),
        ...(typeof provider.options?.baseURL === "string"
          ? { baseURL: provider.options.baseURL }
          : {}),
        ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
      });
    }
  }
  return out;
}

export interface PresetAlias {
  name: string;
  description: string;
  /** Matches the provider key, model key or display name in opencode.json. */
  match: RegExp;
}

/**
 * Thin aliases over `--all-seats`. Deliberately no model id here: the alias
 * says which provider to look for, the user's config says what it is called.
 */
export const SINGLE_MODEL_ALIASES: PresetAlias[] = [
  {
    name: "mimo",
    description: "Every seat on the Xiaomi MiMo model configured in your opencode.json.",
    match: /mimo|xiaomi/i,
  },
];

export function findAlias(name: string): PresetAlias | undefined {
  return SINGLE_MODEL_ALIASES.find((a) => a.name === name);
}

/**
 * Resolve an alias against a loaded config. Errors are strings rather than
 * throws so the CLI can print them and exit cleanly.
 */
export function resolveAlias(
  alias: PresetAlias,
  config: Record<string, any>,
  configPath: string,
): { ok: true; model: ResolvedProviderModel } | { ok: false; error: string } {
  const found = findConfiguredModels(config, alias.match);
  if (found.length === 0) {
    return {
      ok: false,
      error:
        `preset "${alias.name}" found no matching provider in ${configPath}.\n` +
        `  It looks for a provider or model matching ${alias.match} under the "provider" key.\n` +
        `  Configure the provider first, or pass the id directly:\n` +
        `    opencode-teamwork install --all-seats <provider>/<model>`,
    };
  }
  if (found.length > 1) {
    return {
      ok: false,
      error:
        `preset "${alias.name}" matched ${found.length} models in ${configPath}:\n` +
        found.map((m) => `    ${m.modelId}`).join("\n") +
        `\n  Pick one explicitly:\n` +
        `    opencode-teamwork install --all-seats ${found[0]!.modelId}`,
    };
  }
  return { ok: true, model: found[0]! };
}

// ─── Single-model routing policy ─────────────────────────────────────

/**
 * A `Policy.routing` map with every ladder pinned to one model.
 *
 * Upstream's `DEFAULT_POLICY.routing` carries Anthropic and Google ladders;
 * `engine.modelFor()` resolves them and `teamwork_dispatch` prints the result
 * to the sentinel as the model to use. That is advisory text rather than a
 * routing decision, but it is still a vendor string recommended into a seat.
 * Pinning every rung removes the escalation, which is the point: a baseline
 * that escalates to a second model is not a single-model baseline.
 *
 * Shaped as plain data so it can be written to `.teamwork/policy.json` or
 * merged by `loadPolicy` from the environment.
 */
export function singleModelRouting<R extends { ladder: string[] }>(
  modelId: string,
  existing?: Record<string, R>,
): Record<string, R> {
  const out: Record<string, R> = {};
  for (const [key, rule] of Object.entries(existing ?? {})) {
    // One rung. `ladderRung` clamps the index, so every attempt resolves here
    // and the escalate-on-failure step becomes a no-op. Every other field of
    // the rule (topology, requiredChecks) is preserved untouched.
    out[key] = { ...rule, ladder: [modelId] };
  }
  if (!out["default"]) out["default"] = { ladder: [modelId] } as R;
  return out;
}

/** Environment variable that pins the routing ladders at run time. */
export const ALL_SEATS_ENV = "TEAMWORK_ALL_SEATS_MODEL";
