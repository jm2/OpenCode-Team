/**
 * Parse the flags the /teamwork commands accept.
 *
 * Lives outside the plugin entry module on purpose. opencode calls every
 * function the entry module exports as a plugin, so exporting this helper
 * from src/index.ts would have it invoked with the plugin input.
 */

import { isTopology, TOPOLOGY_NAMES } from "./policy.js";

export interface ParsedCommandFlags {
  sessionId?: string;
  topology?: string;
  budgetUsd?: number;
  maxConcurrency?: number;
  request: string;
  warnings: string[];
}

/**
 * Parse the flags the README has always advertised but nothing implemented.
 * Unknown topologies are reported, not silently accepted: the model is told
 * the valid set and the engine rejects the plan if it still gets it wrong.
 */
export function parseCommandFlags(input: string, mint: () => string): ParsedCommandFlags {
  const warnings: string[] = [];
  const tokens = input.split(/\s+/).filter((t) => t.length > 0);
  const rest: string[] = [];
  let sessionId: string | undefined;
  let topology: string | undefined;
  let budgetUsd: number | undefined;
  let maxConcurrency: number | undefined;

  const valueOf = (token: string, flag: string, next: string | undefined): string | undefined => {
    if (token === flag) return next;
    if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
    return undefined;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const lookahead = tokens[i + 1];
    let consumed = false;

    for (const [flag, assign] of [
      ["--topology", (v: string) => { topology = v; }],
      ["--session", (v: string) => { sessionId = v; }],
      ["--budget", (v: string) => { budgetUsd = Number(v); }],
      ["--concurrency", (v: string) => { maxConcurrency = Number.parseInt(v, 10); }],
    ] as Array<[string, (v: string) => void]>) {
      const value = valueOf(token, flag, lookahead);
      if (value !== undefined) {
        assign(value);
        consumed = true;
        // `--flag value` consumes the next token; `--flag=value` does not.
        if (token === flag) i += 1;
        break;
      }
    }

    if (!consumed) rest.push(token);
  }

  if (topology && !isTopology(topology)) {
    warnings.push(`unknown --topology "${topology}"; valid: ${TOPOLOGY_NAMES.join(", ")}. Ignoring it.`);
    topology = undefined;
  }
  if (budgetUsd !== undefined && (!Number.isFinite(budgetUsd) || budgetUsd <= 0)) {
    warnings.push(`--budget must be a positive number; got "${budgetUsd}". Ignoring it.`);
    budgetUsd = undefined;
  }
  if (maxConcurrency !== undefined && (!Number.isInteger(maxConcurrency) || maxConcurrency <= 0)) {
    warnings.push(`--concurrency must be a positive integer. Ignoring it.`);
    maxConcurrency = undefined;
  }

  return {
    ...(sessionId ? { sessionId } : { sessionId: mint() }),
    ...(topology ? { topology } : {}),
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    request: rest.join(" ").trim(),
    warnings,
  };
}
