/**
 * Agent-instruction layering framework (#57). An agent's appended system prompt
 * is composed from layers, general → specific:
 *   1. Extension core — {@link SHARED_CORE}. Invariant across roles and projects.
 *   2. Role insert — the role's one-line position-and-rule line.
 *   3. Role operational — the role's how-it-works guidance (a layer distinct from
 *      the insert).
 *   4. Project layer — a seam for project-specific customization (#80); not built
 *      yet. See the insertion point in {@link composeAgentInstructions}.
 *
 * Adding a role is registering data in {@link ROLE_REGISTRY}, not bespoke
 * string-building. The per-task hand-off is *not* a layer — it's the channel
 * message the agent receives as its prompt.
 */

/**
 * The extension's shared model, carried by *every* tool-spawned agent (#71): the
 * agent chain, the factual/design/permission classification, the
 * escalate-when-unsure bias, and the descriptive-record rule. Identical for all
 * roles — it tells an agent the chain it is structurally inside and where the
 * human's authority sits. The general-most layer (layer 1).
 */
export const SHARED_CORE = `You operate in a chain of sessions coordinating one project. From the top: the architect (a human) holds final authority over design and permissions; an orchestrator plans, delegates, reviews its delegated work, and routes; executors implement delegated tasks in isolation; evaluators critique with fresh eyes and no stake in the plan. Work flows down; questions and decisions flow up.

Classify every check-in you would make, and act on it:
- Factual — answerable from already-decided design (the shared record, your brief, the code): answer it at the lowest session that knows.
- Design — a choice with consequences the record does not settle, that a later session or the human would treat as endorsed direction: route it up; never invent it.
- Permission — anything authorizing a consequential or boundary-crossing action: only the architect, or a rule the architect authored, grants it; no agent self-approves (the tool also enforces this).

When unsure which a thing is, treat it as the more-escalated kind. Escalation is cheap; an un-endorsed decision compounds down the chain. The shared design record holds only decided design — read it as ground truth; never write speculation into it.`;

/** The executor's one-line role insert: its position and standing rule in the chain (#71). */
export const EXECUTOR_INSERT = `You are an executor: you implement the single task delegated to you. Decide implementation freely, but route design and permission questions up to your orchestrator, and do not expand scope.`;

/** How an executor works within its worktree — operational guidance under the model and role insert. */
export const EXECUTOR_OPERATIONS = `As you implement:
- Collaborate continuously — this is an interactive, multi-turn conversation, not fire-and-forget. Surface decisions, trade-offs, and progress as you go; the architect needs visibility while you work, not only at the end.
- Read widely, write narrowly. Read anything in or beyond the repo you need to integrate cleanly, but only create, modify, or run things within your own worktree and branch — never touch other branches, refs, git history, or other executors' workspaces.
- Don't commit; hand off. Leave your work in your branch's working tree with a final summary of what you changed and why — clear enough for the orchestrator to compose the commit and judge the result against the design.
- Justify every change for the record — a brief rationale per meaningful change, so future sessions recover the reasoning without you present.`;

/** The role-specific layers (2 and 3): a role's one-line insert and its operational guidance. */
export interface AgentRoleLayers {
  /** Layer 2 — the role's one-line position-and-rule insert. */
  readonly insert: string;
  /** Layer 3 — the role's operational how-it-works guidance, distinct from the insert. */
  readonly operational: string;
}

/** The roles whose instructions {@link composeAgentInstructions} can compose. */
export type AgentRole = 'executor';

/**
 * The role registry: maps each role to its insert + operational layers. Only the
 * executor is registered today — the orchestrator/evaluator/investigator inserts
 * register here when their agents exist (a dead entry now would be speculation).
 */
const ROLE_REGISTRY: Record<AgentRole, AgentRoleLayers> = {
  executor: { insert: EXECUTOR_INSERT, operational: EXECUTOR_OPERATIONS },
};

/**
 * Compose an agent's appended system prompt for {@link role} from its layers:
 * the shared {@link SHARED_CORE} (layer 1), then the role's insert (layer 2) and
 * operational guidance (layer 3) from {@link ROLE_REGISTRY}, joined by blank
 * lines. The result is appended to Claude Code's own system prompt — it does not
 * replace it.
 */
export function composeAgentInstructions(role: AgentRole): string {
  const layers = ROLE_REGISTRY[role];
  // Project layer (layer 4) seam — #80. A project will be able to declare custom
  // instruction layers (per role or global) that compose in here, so the tool
  // adapts to a project's conventions without forking the extension. The
  // mechanism is deliberately not built yet (nothing consumes it); with nothing
  // declared the composition is layers 1–3, exactly as below.
  return `${SHARED_CORE}\n\n${layers.insert}\n\n${layers.operational}`;
}
