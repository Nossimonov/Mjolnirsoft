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
