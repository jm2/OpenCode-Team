/**
 * Which model each team/* seat is configured to run on, as the plugin saw it
 * in opencode's merged config.
 *
 * opencode's task tool takes no model: a subagent always runs on its agent's
 * configured model. So the configured seat model, not the routing policy's
 * ladder, is what a dispatched worker will actually use, and it is what a
 * run's usage should be checked against.
 */

const seats = new Map<string, string>();

export function recordSeatModels(agents: Record<string, unknown> | undefined): void {
  seats.clear();
  for (const [name, cfg] of Object.entries(agents ?? {})) {
    const model = (cfg as { model?: unknown } | undefined)?.model;
    if (name.startsWith("team/") && typeof model === "string") seats.set(name, model);
  }
}

export function seatModel(role: string): string | undefined {
  return seats.get(role);
}

export function seatModels(): Record<string, string> {
  return Object.fromEntries(seats);
}
