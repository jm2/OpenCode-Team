/**
 * Runtime support for single-model baselines.
 *
 * Imported by the plugin (src/tools.ts) and re-exported by the installer
 * (src/cli/all-seats.ts). Nothing here routes or rewrites a model id; it only
 * collapses the upstream routing ladders onto the one model already assigned
 * to every seat.
 */

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
