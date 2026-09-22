/**
 * Role enforcement.
 *
 * OpenCode's agent `permission` config is the first line of defence, but it
 * depends on the frontmatter being parsed into real config keys (see
 * `agentConfigFor` in templates.ts). This module is the second line: a
 * session → role registry plus hooks that refuse tools a role's contract
 * forbids, so "the verifier cannot edit code" and "a worker cannot fan out
 * its own swarm" stay true even if a user's older OpenCode build ignores
 * part of the permission block.
 *
 * Two contracts are backed here, both read from the agent templates so there
 * is exactly one place to declare them:
 *   - `permission.edit: deny`  -> write tools are refused
 *   - `permission.task: deny`  -> spawning subagents is refused
 */

import { getAllAgentBodies } from "./templates.js";
import { agentPermissions, type AgentPermissions } from "./templates.js";

export type Role =
  | "team/crafter"
  | "team/sentinel"
  | "team/worker"
  | "team/proof-worker"
  | "team/verifier"
  | "team/orchestrator"
  | "team/proposer"
  | "team/falsifier"
  | "team/synthesizer"
  | "team/scout"
  | string;

/** Tools that mutate the workspace. Blocked for read-only roles. */
export const WRITE_TOOLS: readonly string[] = [
  "edit",
  "write",
  "patch",
  "apply_patch",
  "multiedit",
  "multi_edit",
  "notebook_edit",
];

/**
 * Tools that spawn a subagent. Blocked for roles declared `task: deny`.
 *
 * Deliberately narrow: only OpenCode's actual delegation tool. Guessing at
 * aliases risks refusing something unrelated, which is worse than the gap
 * this closes.
 */
export const TASK_TOOLS: readonly string[] = ["task"];

/** Agents allowed to drive the run engine. Everything else is a worker/critic. */
export const ENGINE_ROLES: readonly string[] = ["team/sentinel", "team/orchestrator"];

export interface RolePolicy {
  /** May this role call write tools? */
  canEdit: boolean;
  /** May this role dispatch tasks / drive the DAG? */
  canOrchestrate: boolean;
  /** May this role run shell commands? */
  canBash: boolean;
}

/** Read the declared permissions straight from the agent templates. */
export function policyForRole(role: string, effective?: AgentPermissions): RolePolicy {
  const short = role.startsWith("team/") ? role.slice("team/".length) : role;
  const declared = effective ?? agentPermissions(short);
  const permission = declared ?? { edit: "ask", bash: "ask", webfetch: "allow", task: "allow" };
  return {
    canEdit: permission.edit !== "deny",
    canBash: permission.bash !== "deny",
    canOrchestrate: ENGINE_ROLES.includes(role),
  };
}

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.includes(toolName.toLowerCase());
}

export function isTaskTool(toolName: string): boolean {
  return TASK_TOOLS.includes(toolName.toLowerCase());
}

/** Session → role registry, populated from chat.message + tool contexts. */
export class RoleRegistry {
  private readonly roles = new Map<string, string>();
  private readonly effective = new Map<string, AgentPermissions>();

  remember(sessionID: string, agent: string | undefined): void {
    if (sessionID && agent) this.roles.set(sessionID, agent);
  }

  roleFor(sessionID: string): string | undefined {
    return this.roles.get(sessionID);
  }

  /**
   * Record the permissions actually injected into the config (after any user
   * override), so the runtime guard agrees with what OpenCode enforces.
   */
  setPermissions(role: string, permissions: AgentPermissions): void {
    this.effective.set(role, permissions);
  }

  effectivePermissions(role: string): AgentPermissions | undefined {
    return this.effective.get(role);
  }

  /**
   * Decide whether a tool call should be blocked. Unknown sessions fail open
   * (we don't want to break a user's normal `build` agent), but known roles
   * fail closed on the contracts they declare.
   */
  blockReason(sessionID: string, toolName: string): string | null {
    const role = this.roles.get(sessionID);
    if (!role) return null;
    if (!role.startsWith("team/")) return null;
    const declared = this.effective.get(role) ?? agentPermissions(role.slice("team/".length));
    if (!declared) return null;

    if (isWriteTool(toolName) && declared.edit === "deny") {
      return (
        `teamwork: ${role} is declared read-only (permission.edit: deny) and may not call "${toolName}". ` +
        `Report the finding to the sentinel instead; the sentinel re-dispatches a worker.`
      );
    }

    // Every leaf role declares task: deny so a worker cannot start its own
    // swarm. Until now that rested entirely on OpenCode honouring the config,
    // with no second line behind it — unlike the edit rule beside it. An
    // ignored permission block meant unbounded fan-out, with the concurrency
    // cap and the budget applying to none of it.
    if (isTaskTool(toolName) && declared.task === "deny") {
      return (
        `teamwork: ${role} may not spawn subagents (permission.task: deny). ` +
        `Do your own task and return the result; only ${ENGINE_ROLES.join(" and ")} dispatch work.`
      );
    }

    return null;
  }

  /** Agents that may edit, for diagnostics. */
  roster(): Record<string, RolePolicy> {
    const out: Record<string, RolePolicy> = {};
    for (const body of Object.keys(getAllAgentBodies())) {
      out[`team/${body}`] = policyForRole(`team/${body}`, this.effective.get(`team/${body}`));
    }
    return out;
  }
}
