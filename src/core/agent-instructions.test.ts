import { describe, it, expect } from 'vitest';
import {
  composeAgentInstructions,
  isAgentRole,
  SHARED_CORE,
  ORCHESTRATOR_INSERT,
  ORCHESTRATOR_OPERATIONS,
  EXECUTOR_INSERT,
  EXECUTOR_OPERATIONS,
  EVALUATOR_INSERT,
  EVALUATOR_OPERATIONS,
  ARBITRATOR_INSERT,
  ARBITRATOR_OPERATIONS,
} from './agent-instructions.ts';

describe('composeAgentInstructions (#57)', () => {
  it('composes core + role insert + role operational from the registry, in order', () => {
    const composed = composeAgentInstructions('executor');
    const coreAt = composed.indexOf(SHARED_CORE);
    const insertAt = composed.indexOf(EXECUTOR_INSERT);
    const opsAt = composed.indexOf(EXECUTOR_OPERATIONS);
    expect(coreAt).toBe(0); // the shared core leads, general-most layer first
    expect(insertAt).toBeGreaterThan(coreAt);
    expect(opsAt).toBeGreaterThan(insertAt);
  });

  it('keeps the operational guidance a layer distinct from the role insert', () => {
    // Not folded together: the insert is the one-line position/rule; operational
    // is the separate how-it-works block, joined by a blank line.
    expect(EXECUTOR_OPERATIONS).not.toContain(EXECUTOR_INSERT);
    expect(composeAgentInstructions('executor')).toContain(`${EXECUTOR_INSERT}\n\n${EXECUTOR_OPERATIONS}`);
  });

  it("is byte-identical to today's hand-assembled executor prompt (refactor safety net)", () => {
    // Locks the composition (layer order + blank-line separators) so routing the
    // executor through the framework changes its effective prompt by zero bytes.
    expect(composeAgentInstructions('executor')).toBe(
      `${SHARED_CORE}\n\n${EXECUTOR_INSERT}\n\n${EXECUTOR_OPERATIONS}`,
    );
  });

  it('puts the bookkeeping rule in the shared core: orchestrator owns it, executors/evaluators excluded (#80/#121)', () => {
    // Bookkeeping is the orchestrator's domain (coordinated with the architect),
    // not fenced off from it. Executors and evaluators still never run it.
    expect(SHARED_CORE).toContain('Project bookkeeping');
    // Orchestrator ownership:
    expect(SHARED_CORE).toContain('owned by the orchestrator');
    expect(SHARED_CORE).toContain('in coordination with the architect');
    // Executors/evaluators/arbitrators excluded:
    expect(SHARED_CORE).toContain('Executors, evaluators, and arbitrators never run it');
    // Old "belongs to the architect" framing is gone:
    expect(SHARED_CORE).not.toContain('belongs to the architect, not a subordinate agent');
    expect(SHARED_CORE).not.toContain('the architect tracks it');
    // Every composed role carries the bookkeeping rule:
    expect(composeAgentInstructions('orchestrator')).toContain('Project bookkeeping');
    expect(composeAgentInstructions('executor')).toContain('Project bookkeeping');
    expect(composeAgentInstructions('evaluator')).toContain('Project bookkeeping');
  });

  it('directs every agent to read AGENTS.md and its role norms file before working (#80)', () => {
    // Pull-on-demand: the agent reads the project norms itself rather than having
    // the extension inject them. The directive lives in SHARED_CORE so it reaches
    // every spawned role.
    expect(SHARED_CORE).toContain('AGENTS.md');
    expect(SHARED_CORE).toContain("role's norms file");
    expect(composeAgentInstructions('orchestrator')).toContain('AGENTS.md');
    expect(composeAgentInstructions('executor')).toContain('AGENTS.md');
    expect(composeAgentInstructions('evaluator')).toContain('AGENTS.md');
  });

  it('tells the orchestrator it owns bookkeeping; its operational layer reflects that (#80)', () => {
    // The orchestrator's operational guidance now includes an explicit bookkeeping-
    // ownership bullet, not a "tracking happens above you" deferral.
    expect(ORCHESTRATOR_OPERATIONS).toContain('Own the project');
    expect(ORCHESTRATOR_OPERATIONS).toContain('bookkeeping protocol');
    expect(ORCHESTRATOR_OPERATIONS).toContain('in coordination with the architect');
  });

  it('tells every agent to ask upward for missing context rather than self-survey (#131)', () => {
    // Pairs with denying the native sub-agent tool: an agent can't spin up an ad-hoc
    // survey, and the context it lacks is usually already known above it — so ask up.
    expect(SHARED_CORE).toContain('ad-hoc sub-agents');
    expect(SHARED_CORE).toContain('Ask upward');
    expect(composeAgentInstructions('executor')).toContain('Ask upward');
  });

  it('tells every agent to surface learnings up, not keep private memory that evaporates (#132)', () => {
    // Auto-memory is disabled for spawned agents (their worktree-keyed memory orphans);
    // the durable home for a learning is the hand-off up to the architect.
    expect(SHARED_CORE).toContain("don't keep private notes or memory");
    expect(SHARED_CORE).toContain('hand-off');
  });

  it('makes the executor self-sufficient without CLAUDE.md: test the change, stay in scope, route discoveries up (#121)', () => {
    // Spawned with --bare (no project CLAUDE.md), the executor's layer must carry
    // the slice it needs itself: cover its change with a test, and treat any
    // out-of-scope discovery as something to surface up — never self-file issues or
    // run project tracking (the ceremony that #121 removes).
    expect(EXECUTOR_OPERATIONS).toContain('Cover your change with a test');
    expect(EXECUTOR_OPERATIONS).toContain('Stay in the delegated scope');
    expect(EXECUTOR_OPERATIONS).toContain('do not file issues');
    expect(EXECUTOR_OPERATIONS).toContain('Tracking happens above you');
  });

  it('composes the orchestrator role from the same layers — plan, delegate, review, integrate (#114/#137/#153)', () => {
    const composed = composeAgentInstructions('orchestrator');
    // Same shared core, then the orchestrator's own insert and operational layers,
    // in the same general → specific order joined by blank lines.
    expect(composed).toBe(`${SHARED_CORE}\n\n${ORCHESTRATOR_INSERT}\n\n${ORCHESTRATOR_OPERATIONS}`);
    expect(composed.indexOf(SHARED_CORE)).toBe(0);
    // The insert carries the standing rules: delegate tasks to executors, integrate
    // results via PRs, route decisions (including which tasks to parallelize) up to
    // the architect. No longer carries a "one task at a time" prohibition (#153).
    expect(ORCHESTRATOR_INSERT).not.toContain('one task at a time');
    expect(ORCHESTRATOR_INSERT).toContain('delegate');
    expect(ORCHESTRATOR_INSERT).toContain('pull request');
    expect(ORCHESTRATOR_INSERT).toContain('route every design and permission decision');
    // Operational guidance is a distinct layer from the insert.
    expect(ORCHESTRATOR_OPERATIONS).not.toContain(ORCHESTRATOR_INSERT);
    // #137: the orchestrator reviews the delegate's branch and integrates it by pushing
    // + opening a PR (the architect's merge is the ratification), or refines via #111.
    expect(ORCHESTRATOR_OPERATIONS).toContain('open a pull request');
    expect(ORCHESTRATOR_OPERATIONS).toContain('the architect reviews and merges');
    // #142: active pre-action gate — before opening any diff the orchestrator must
    // name the specific unresolved question it will answer; if it can't, it integrates
    // from the hand-off as it stands; when it does reach in, it states that question
    // first and reads only what answers it (never a wholesale diff pull).
    expect(ORCHESTRATOR_OPERATIONS).toContain('from the distilled hand-off');
    expect(ORCHESTRATOR_OPERATIONS).toContain('name the specific unresolved question');
    expect(ORCHESTRATOR_OPERATIONS).toContain("can't name one");
    expect(ORCHESTRATOR_OPERATIONS).toContain('state that question first');
  });

  it('composes the evaluator role from the same layers — fresh eyes, critique-only (#93)', () => {
    const composed = composeAgentInstructions('evaluator');
    // Same shared core (the agent chain + classification), then the evaluator's
    // own insert and operational layers, in the same general → specific order.
    expect(composed).toBe(`${SHARED_CORE}\n\n${EVALUATOR_INSERT}\n\n${EVALUATOR_OPERATIONS}`);
    expect(composed.indexOf(SHARED_CORE)).toBe(0);
    // The insert carries the standing rule: critique, never modify.
    expect(EVALUATOR_INSERT).toContain('Critique only');
    expect(EVALUATOR_INSERT).toContain('never modify');
    // Phrased generally ("changes or state"), so the one role reads for an
    // executor's diff, an orchestrator's design, and a contributor's PR alike.
    expect(EVALUATOR_INSERT).toContain('changes or state');
  });
});

describe('session-log literacy in the shared core (#102)', () => {
  it('teaches reading a recorded interaction: outcome in updatedInput.answers', () => {
    // The pick lives in the decision's answers map, keyed by question.
    expect(SHARED_CORE).toContain('interaction-request');
    expect(SHARED_CORE).toContain('interaction-decision');
    expect(SHARED_CORE).toContain('updatedInput.answers');
    // And explicitly NOT from the option list or the (recommended) marker —
    // the misread that nearly stripped approved work on #100.
    expect(SHARED_CORE).toContain('(Recommended)');
    expect(SHARED_CORE.toLowerCase()).toContain('not what was decided');
  });

  it('reaches every log-reading role via composeAgentInstructions', () => {
    // It rides in SHARED_CORE, so every composed role carries it. Assert on the
    // roles that exist today; new log-reading roles inherit it for free.
    expect(composeAgentInstructions('orchestrator')).toContain('updatedInput.answers');
    expect(composeAgentInstructions('executor')).toContain('updatedInput.answers');
    expect(composeAgentInstructions('evaluator')).toContain('updatedInput.answers');
  });
});

describe('evaluator distinguishes legible findings from judgment calls (#104)', () => {
  it('the role text carries the legible-vs-judgment classification', () => {
    expect(EVALUATOR_OPERATIONS).toContain('legible');
    expect(EVALUATOR_OPERATIONS).toContain('judgment');
  });

  it('marks which findings are legible vs. judgment-to-route', () => {
    // The finding must tag the two kinds so the spawner knows what to act on.
    expect(EVALUATOR_OPERATIONS).toContain('judgment-to-route');
  });

  it('raises judgment calls by reporting up the chain — spawner escalates', () => {
    // Chosen mechanism (#104 fork): role-text-only, the spawner escalates.
    expect(EVALUATOR_OPERATIONS).toContain('spawner escalates');
  });

  it('encodes the inversion: unreconstructable intent is a routed judgment, not a cold defect', () => {
    expect(EVALUATOR_OPERATIONS).toContain("couldn't reconstruct the intent");
  });

  it('still carries the classification when composed for the evaluator role', () => {
    expect(composeAgentInstructions('evaluator')).toContain('judgment-to-route');
  });
});

describe('isAgentRole (#93)', () => {
  it('accepts the tool-spawnable agent roles and rejects the human/unknown roles', () => {
    expect(isAgentRole('orchestrator')).toBe(true);
    expect(isAgentRole('executor')).toBe(true);
    expect(isAgentRole('evaluator')).toBe(true);
    expect(isAgentRole('arbitrator')).toBe(true);
    // `planner` is the human seat — no composed prompt — and anything else is unknown.
    expect(isAgentRole('planner')).toBe(false);
    expect(isAgentRole('')).toBe(false);
    expect(isAgentRole('investigator')).toBe(false);
  });
});

describe('arbitrator role (#99)', () => {
  it('is a recognized agent role: isAgentRole returns true', () => {
    expect(isAgentRole('arbitrator')).toBe(true);
  });

  it('composes in the same general → specific shape as the other roles', () => {
    const composed = composeAgentInstructions('arbitrator');
    expect(composed).toBe(`${SHARED_CORE}\n\n${ARBITRATOR_INSERT}\n\n${ARBITRATOR_OPERATIONS}`);
    expect(composed.indexOf(SHARED_CORE)).toBe(0);
    expect(composed.indexOf(ARBITRATOR_INSERT)).toBeGreaterThan(0);
    expect(composed.indexOf(ARBITRATOR_OPERATIONS)).toBeGreaterThan(composed.indexOf(ARBITRATOR_INSERT));
  });

  it('the insert carries the key semantics: neutral, reconcile two sides, no new design, escalate when unresolvable', () => {
    expect(ARBITRATOR_INSERT).toContain('neutral');
    expect(ARBITRATOR_INSERT).toContain('no stake');
    expect(ARBITRATOR_INSERT).toContain('intent');
    expect(ARBITRATOR_INSERT).toContain('never author new design');
    expect(ARBITRATOR_INSERT).toContain('escalate');
    expect(ARBITRATOR_INSERT).toContain('architect');
    expect(ARBITRATOR_INSERT).toContain('record cannot settle');
  });

  it('the operations layer is distinct from the insert and directs reading both session logs', () => {
    expect(ARBITRATOR_OPERATIONS).not.toContain(ARBITRATOR_INSERT);
    expect(ARBITRATOR_OPERATIONS).toContain('session log');
    expect(ARBITRATOR_OPERATIONS).toContain('session store');
  });

  it('the operations layer directs escalation via a precise question, not guessing', () => {
    // The bullet starts with a capital "Escalate"; check the full context instead.
    expect(ARBITRATOR_OPERATIONS).toContain('Escalate when the record cannot settle');
    expect(ARBITRATOR_OPERATIONS).toContain('precise question');
    expect(ARBITRATOR_OPERATIONS).toContain('rather than guessing');
  });

  it('the operations layer directs producing the reconciled result in the worktree, committing it, and handing off', () => {
    expect(ARBITRATOR_OPERATIONS).toContain('your own worktree');
    expect(ARBITRATOR_OPERATIONS).toContain('hand off');
    expect(ARBITRATOR_OPERATIONS).toContain('no closing keyword');
  });

  it('the composed arbitrator instructions carry SHARED_CORE (session-log literacy, bookkeeping, etc.)', () => {
    const composed = composeAgentInstructions('arbitrator');
    expect(composed).toContain('updatedInput.answers');
    expect(composed).toContain('Project bookkeeping');
    expect(composed).toContain('AGENTS.md');
  });
});

describe('orchestrator parallel delegation, architect-directed (#153)', () => {
  it('ORCHESTRATOR_OPERATIONS permits parallel delegation under architect direction and no longer hard-forbids it', () => {
    // The old prohibition is gone.
    expect(ORCHESTRATOR_OPERATIONS).not.toContain("don't run delegates in parallel");
    // Parallel execution is permitted — when the architect directs it.
    expect(ORCHESTRATOR_OPERATIONS).toContain('architect directs');
    expect(ORCHESTRATOR_OPERATIONS).toContain('concurrently');
  });

  it('ORCHESTRATOR_OPERATIONS specifies that concurrent delegation is not unilateral', () => {
    // The orchestrator never initiates parallel delegation on its own — that decision
    // belongs to the architect.
    expect(ORCHESTRATOR_OPERATIONS).toContain('unilaterally');
    expect(ORCHESTRATOR_OPERATIONS).toContain('Never initiate concurrent delegation unilaterally');
  });

  it('ORCHESTRATOR_OPERATIONS directs the orchestrator to spot and flag parallelization opportunities (standing advisory behavior)', () => {
    // A standing behavior: proactively identify independent, non-overlapping work and
    // bring the opportunity to the architect with a recommendation before delegating.
    expect(ORCHESTRATOR_OPERATIONS).toContain('Spot and flag parallelization opportunities');
    expect(ORCHESTRATOR_OPERATIONS).toContain('the architect decides');
    expect(ORCHESTRATOR_OPERATIONS).toContain('standing advisory behavior');
  });

  it('ORCHESTRATOR_OPERATIONS directs using an Arbitrator for conflicting parallel branches at integration', () => {
    // When parallel branches conflict at integration, spawn an Arbitrator delegate
    // with both branch names and each side's session id; non-conflicting branches
    // integrate as separate PRs.
    expect(ORCHESTRATOR_OPERATIONS).toContain('Arbitrator');
    expect(ORCHESTRATOR_OPERATIONS).toContain('arbitrator');
    expect(ORCHESTRATOR_OPERATIONS).toContain('session id');
    expect(ORCHESTRATOR_OPERATIONS).toContain('Non-conflicting parallel branches integrate as separate PRs');
  });

  it('ORCHESTRATOR_INSERT no longer carries the one-task-at-a-time constraint and routes parallelization to the architect', () => {
    expect(ORCHESTRATOR_INSERT).not.toContain('one task at a time');
    // Architect-direction for concurrency is still prominent in the insert.
    expect(ORCHESTRATOR_INSERT).toContain('architect directs');
  });
});

describe('orchestrator proactive compaction and drift-safeguard (#165)', () => {
  it('ORCHESTRATOR_OPERATIONS contains the proactive-compaction clause', () => {
    // The clause directs the orchestrator to call mcp__compact__request at task
    // boundaries when the context note signals it is past the threshold.
    expect(ORCHESTRATOR_OPERATIONS).toContain('mcp__compact__request');
    expect(ORCHESTRATOR_OPERATIONS).toContain('self-hand-off');
    expect(ORCHESTRATOR_OPERATIONS).toContain('no live delegate');
    expect(ORCHESTRATOR_OPERATIONS).toContain('Context size');
  });

  it('ORCHESTRATOR_OPERATIONS carries the task-boundary constraint for compaction', () => {
    // Compaction fires at task boundaries only, never mid-delegation.
    expect(ORCHESTRATOR_OPERATIONS).toContain('task boundaries only');
    expect(ORCHESTRATOR_OPERATIONS).toContain('Do NOT call it mid-delegation');
  });

  it('ORCHESTRATOR_OPERATIONS contains the compaction-drift safeguard', () => {
    // After a compaction, recalled details must be verified against primary sources.
    expect(ORCHESTRATOR_OPERATIONS).toContain('drift safeguard');
    expect(ORCHESTRATOR_OPERATIONS).toContain('primary source');
    expect(ORCHESTRATOR_OPERATIONS).toContain('re-verification');
  });

  it('the composed orchestrator instructions carry both compaction clauses', () => {
    const composed = composeAgentInstructions('orchestrator');
    expect(composed).toContain('mcp__compact__request');
    expect(composed).toContain('drift safeguard');
  });

  it('executor and evaluator instructions do NOT carry the compaction clause (orchestrator-only)', () => {
    // Compaction is an orchestrator concern — no other role has context longevity.
    expect(composeAgentInstructions('executor')).not.toContain('mcp__compact__request');
    expect(composeAgentInstructions('evaluator')).not.toContain('mcp__compact__request');
  });
});
