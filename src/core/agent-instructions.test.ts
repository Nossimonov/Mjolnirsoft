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
    // Executors/evaluators excluded:
    expect(SHARED_CORE).toContain('Executors and evaluators never run it');
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

  it('composes the orchestrator role from the same layers — plan, delegate, review, integrate (#114/#137)', () => {
    const composed = composeAgentInstructions('orchestrator');
    // Same shared core, then the orchestrator's own insert and operational layers,
    // in the same general → specific order joined by blank lines.
    expect(composed).toBe(`${SHARED_CORE}\n\n${ORCHESTRATOR_INSERT}\n\n${ORCHESTRATOR_OPERATIONS}`);
    expect(composed.indexOf(SHARED_CORE)).toBe(0);
    // The insert carries the standing rules: delegate one task at a time, integrate
    // the result via a PR, route decisions up rather than settling them.
    expect(ORCHESTRATOR_INSERT).toContain('delegate one task at a time');
    expect(ORCHESTRATOR_INSERT).toContain('pull request');
    expect(ORCHESTRATOR_INSERT).toContain('Route every design and permission decision up to the architect');
    // Operational guidance is a distinct layer from the insert.
    expect(ORCHESTRATOR_OPERATIONS).not.toContain(ORCHESTRATOR_INSERT);
    // #137: the orchestrator reviews the delegate's branch and integrates it by pushing
    // + opening a PR (the architect's merge is the ratification), or refines via #111.
    expect(ORCHESTRATOR_OPERATIONS).toContain('open a pull request');
    expect(ORCHESTRATOR_OPERATIONS).toContain('the architect reviews and merges');
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
    // `planner` is the human seat — no composed prompt — and anything else is unknown.
    expect(isAgentRole('planner')).toBe(false);
    expect(isAgentRole('')).toBe(false);
    expect(isAgentRole('investigator')).toBe(false);
  });
});
