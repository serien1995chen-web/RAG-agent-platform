import { describe, expect, it } from 'vitest';
import { deepBudgetOf, deepStopReason } from '../../src';

describe('TEST-X-DEEP-BUDGET bounded budget and stop order', () => {
  const base = {
    round: 1,
    maxRounds: 3,
    sufficient: false,
    hasNewEvidence: true,
    stopWhenNoNewEvidence: true,
    remainingTokens: 1_000,
    dependencyFailed: false,
    hasEvidence: false,
  };

  it('uses min(round budget, remaining total) and never a negative balance', () => {
    expect(deepBudgetOf({ tokenBudget: 12_000, roundTokenBudget: 5_000 }, 2_000)).toEqual({
      totalTokens: 12_000,
      roundTokens: 5_000,
      remainingTokens: 10_000,
    });
    expect(deepBudgetOf({ tokenBudget: 1_000, roundTokenBudget: 5_000 }, 1_200)).toEqual({
      totalTokens: 1_000,
      roundTokens: 0,
      remainingTokens: 0,
    });
  });

  it('applies dependency, sufficient, no-new-evidence, round and budget stops in order', () => {
    expect(
      deepStopReason({ ...base, dependencyFailed: true, hasEvidence: true, sufficient: true }),
    ).toBe('dependency_failure');
    expect(deepStopReason({ ...base, sufficient: true })).toBe('sufficient');
    expect(deepStopReason({ ...base, hasNewEvidence: false })).toBe('no_new_evidence');
    expect(deepStopReason({ ...base, round: 3 })).toBe('round_limit');
    expect(deepStopReason({ ...base, remainingTokens: 0 })).toBe('token_budget');
    expect(deepStopReason(base)).toBeNull();
  });
});
