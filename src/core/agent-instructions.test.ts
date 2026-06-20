import { describe, it, expect } from 'vitest';
import {
  composeAgentInstructions,
  isAgentRole,
  SHARED_CORE,
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
    expect(isAgentRole('executor')).toBe(true);
    expect(isAgentRole('evaluator')).toBe(true);
    // `planner` is the human seat — no composed prompt — and anything else is unknown.
    expect(isAgentRole('planner')).toBe(false);
    expect(isAgentRole('')).toBe(false);
    expect(isAgentRole('investigator')).toBe(false);
  });
});
