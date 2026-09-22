/**
 * opencode-teamwork plugin entry.
 *
 * Responsibilities:
 *
 * 1. Register the team/* agents with REAL config keys — mode, permission,
 *    temperature, color, description — instead of dumping the markdown
 *    frontmatter into the system prompt. `permission.edit: deny` on the
 *    verifier is what makes "the verifier cannot write" true.
 * 2. Register the run engine as tools (teamwork_plan / _dispatch / _verify /
 *    _status / _resume) so dispatch order, retries, budget and terminal
 *    state are owned by code rather than by the model's memory.
 * 3. Enforce the role contracts at runtime: read-only roles cannot call write
 *    tools, whatever the prompt says or the user's OpenCode version honours.
 * 4. Parse command flags in code (`--topology`, `--budget`, `--concurrency`)
 *    and hand the model a pre-resolved run context.
 * 5. Keep a long run alive across compaction by re-injecting the plan, the
 *    open tasks and the budget from the event log.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";
import { deriveSession, describeLogDamage, readEventLog, verifyChain } from "./events.js";
import { RoleRegistry } from "./guard.js";
import { assertTopologiesResolve } from "./policy.js";
import { parseCommandFlags } from "./flags.js";
import { getAllCommands, agentConfigs } from "./templates.js";
import { TEAMWORK_TOOLS } from "./tools.js";
import { readRunPointer, writeRunPointer } from "./run-pointer.js";
import { TELEMETRY_ENV, UsageObserver } from "./telemetry.js";
import { runDirFor } from "./worktree.js";
// Command-flag parsing lives in ./flags.ts; see the export note at the end of this file.

export const TeamPlugin: Plugin = async (ctx) => {
  const roles = new RoleRegistry();
  const runBySession = new Map<string, string>(); // opencode sessionID -> run sessionId

  // Metered usage for every session tree that belongs to a run: the session
  // that ran /teamwork and every subagent under it.
  const usage = new UsageObserver({
    runDirFor: (root) => {
      const runId =
        runBySession.get(root) ??
        (() => {
          const pointer = readRunPointer(ctx.directory);
          return pointer?.opencodeSessionID === root ? pointer.sessionId : undefined;
        })();
      if (!runId) return null;
      const dir = runDirFor(ctx.directory, runId);
      return existsSync(dir) ? dir : null;
    },
    ...(process.env[TELEMETRY_ENV] ? { telemetryFile: process.env[TELEMETRY_ENV] } : {}),
  });

  return {
    /**
     * Inject agents (structured) and commands. Merges with what is already in
     * the user's config instead of replacing it — the previous version
     * clobbered the per-role `model` that the installer had just written.
     */
    config: async (config) => {
      const existing = (config.agent ?? {}) as Record<string, Record<string, unknown>>;
      config.agent = { ...existing };
      for (const [name, injected] of Object.entries(agentConfigs(existing))) {
        const prior = existing[name] ?? {};
        const priorPermission =
          prior["permission"] && typeof prior["permission"] === "object"
            ? (prior["permission"] as Record<string, unknown>)
            : {};
        const model = { ...prior, ...injected, permission: { ...injected.permission, ...priorPermission } };
        config.agent[name] = model as never;
        roles.setPermissions(
          name,
          {
            edit: (model.permission as Record<string, string>)["edit"] as "allow" | "deny" | "ask",
            bash: (model.permission as Record<string, string>)["bash"] as "allow" | "deny" | "ask",
            webfetch: (model.permission as Record<string, string>)["webfetch"] as
              | "allow"
              | "deny"
              | "ask",
            task: (model.permission as Record<string, string>)["task"] as "allow" | "deny" | "ask",
          },
        );
      }

      config.command = config.command ?? {};
      for (const cmd of getAllCommands()) {
        config.command[cmd.name] = {
          template: cmd.template,
          description: cmd.description,
          agent: cmd.agent,
        };
      }
    },

    /** The run engine, as tools. */
    tool: TEAMWORK_TOOLS,

    /** Remember which agent owns which session (drives the write guard). */
    "chat.message": async (input) => {
      roles.remember(input.sessionID, input.agent);
    },

    /** Refuse write tools for read-only roles. */
    "tool.execute.before": async (input) => {
      const reason = roles.blockReason(input.sessionID, input.tool);
      if (reason) throw new Error(reason);
    },

    /** Second line of defence: deny at the permission prompt. */
    "permission.ask": async (input, output) => {
      const role = roles.roleFor(input.sessionID);
      if (!role) return;
      if (!/^edit|write|patch/i.test(input.type)) return;
      if (roles.effectivePermissions(role)?.edit === "deny") output.status = "deny";
    },

    /**
     * Parse flags in code, mint the run id, and leave a pointer the command
     * template and the tools can both read. The command body itself contains
     * no templating language — OpenCode only understands $ARGUMENTS, $1..$N,
     * !`cmd` and @file, so anything else reached the model as literal braces.
     */
    "command.execute.before": async (input) => {
      if (!input.command.startsWith("teamwork") && !input.command.startsWith("team-")) return;
      const flags = parseCommandFlags(input.arguments ?? "", () => {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
        return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
      });
      const projectDir = ctx.directory;
      const runDir = runDirFor(projectDir, flags.sessionId!);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, "request.md"),
        `# Request\n\n${flags.request || "(no request text)"}\n\n# Parsed flags\n\n\`\`\`json\n${JSON.stringify(flags, null, 2)}\n\`\`\`\n`,
        "utf-8",
      );
      writeRunPointer(projectDir, {
        sessionId: flags.sessionId!,
        ...(flags.topology ? { topology: flags.topology } : {}),
        ...(flags.budgetUsd !== undefined ? { budgetUsd: flags.budgetUsd } : {}),
        ...(flags.maxConcurrency !== undefined ? { maxConcurrency: flags.maxConcurrency } : {}),
        ...(flags.budgetEnforced !== undefined ? { budgetEnforced: flags.budgetEnforced } : {}),
        request: flags.request,
        createdAt: new Date().toISOString(),
        opencodeSessionID: input.sessionID,
      });
      runBySession.set(input.sessionID, flags.sessionId!);
      await ctx.client.app
        .log({
          body: {
            service: "opencode-teamwork",
            level: flags.warnings.length > 0 ? "warn" : "info",
            message: `teamwork run ${flags.sessionId} prepared${flags.topology ? ` topology=${flags.topology}` : ""}`,
            extra: { warnings: flags.warnings, runDir },
          },
        })
        .catch(() => undefined);
    },

    /**
     * Long runs get compacted; a compacted model that has forgotten the DAG
     * is worse than a slow one. Re-inject the plan, open tasks and budget
     * straight from the event log.
     */
    "experimental.session.compacting": async (input, output) => {
      const runId =
        runBySession.get(input.sessionID) ?? readRunPointer(ctx.directory)?.sessionId ?? undefined;
      if (!runId) return;
      const runDir = runDirFor(ctx.directory, runId);
      if (!existsSync(runDir)) return;
      const log = readEventLog(runDir);
      const events = log.events;
      const damage = describeLogDamage(log);
      if (damage) {
        output.context.push(
          `Teamwork run ${runId}: ${damage} Do not continue from remembered state; call teamwork_resume and report the damage to the user.`,
        );
        return;
      }
      if (events.length === 0) return;
      if (!verifyChain(events).ok) {
        output.context.push(
          `Teamwork run ${runId}: the event log failed its integrity check. Do not trust any remembered state; call teamwork_resume and report the corruption.`,
        );
        return;
      }
      const derived = deriveSession(events);
      const rows = derived.order.map(
        (id) => `- ${id}: ${derived.tasks[id]?.status} (attempts ${derived.tasks[id]?.attempts ?? 0})`,
      );
      output.context.push(
        [
          `## Active Teamwork run: ${runId}`,
          "",
          `Topology: ${derived.topology ?? "unspecified"} | cost $${derived.costUsd.toFixed(2)} of $${derived.budgetUsd.toFixed(2)} | rounds ${derived.rounds}`,
          "",
          "Task state (from the event log — authoritative):",
          ...rows,
          derived.deadletter.length > 0 ? `Dead-lettered: ${derived.deadletter.join(", ")}` : "",
          "",
          "Dispatch order, retries and budget are owned by the engine. Call teamwork_status for the",
          "authoritative next step; do not re-plan from memory.",
        ]
          .filter((l) => l !== "")
          .join("\n"),
      );
    },

    event: async ({ event }) => {
      try {
        usage.onEvent(event as never);
      } catch {
        // Observation must never break a session.
      }
      if (event.type !== "session.error") return;
      const sessionID = (event.properties as { sessionID?: string }).sessionID;
      if (!sessionID) return;
      await ctx.client.app
        .log({
          body: {
            service: "opencode-teamwork",
            level: "error",
            message: `session error in ${sessionID}`,
            extra: { run: runBySession.get(sessionID) ?? null },
          },
        })
        .catch(() => undefined);
    },

    dispose: async () => {
      const check = assertTopologiesResolve();
      if (!check.ok) {
        await ctx.client.app
          .log({
            body: {
              service: "opencode-teamwork",
              level: "warn",
              message: `topology patterns missing: ${check.missing.join(", ")}`,
            },
          })
          .catch(() => undefined);
      }
    },
  };
};

/*
 * Every runtime export of this module must be the plugin function.
 *
 * opencode's plugin loader walks Object.values() of the module, calls each
 * distinct function as a plugin, and throws "Plugin export is not a
 * function" for anything else, skipping the plugin entirely. It used to
 * export `id` (a string) and DEFAULT_POLICY (an object) here, so the plugin
 * never loaded, and opencode only says so in its log. Aliases of the same
 * function are fine: the loader de-duplicates them. Helpers belong in their
 * own modules (parseCommandFlags is in ./flags.ts; DEFAULT_POLICY is in
 * ./policy.ts and the package's "./policy" export).
 */
export default TeamPlugin;
export { TeamPlugin as server };
export { TeamPlugin as setup };
