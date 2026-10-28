import type { DeepSearchApiRequest, DeepSearchRound } from '@kb/contracts';

export type DeepStopReason =
  | 'sufficient'
  | 'round_limit'
  | 'token_budget'
  | 'no_new_evidence'
  | 'dependency_failure';

export interface DeepBudgetState {
  totalTokens: number;
  roundTokens: number;
  remainingTokens: number;
}

export interface DeepStopInput {
  round: number;
  maxRounds: number;
  sufficient: boolean;
  hasNewEvidence: boolean;
  stopWhenNoNewEvidence: boolean;
  remainingTokens: number;
  dependencyFailed: boolean;
  hasEvidence: boolean;
}

export function deepBudgetOf(
  input: Pick<DeepSearchApiRequest, 'tokenBudget' | 'roundTokenBudget'>,
  usedTokens: number,
): DeepBudgetState {
  const totalTokens = Math.max(0, input.tokenBudget);
  const remainingTokens = Math.max(0, totalTokens - Math.max(0, usedTokens));
  return {
    totalTokens,
    roundTokens: Math.min(input.roundTokenBudget, remainingTokens),
    remainingTokens,
  };
}

export function deepStopReason(input: DeepStopInput): DeepStopReason | null {
  if (input.dependencyFailed && input.hasEvidence) return 'dependency_failure';
  if (input.sufficient) return 'sufficient';
  if (!input.hasNewEvidence && input.stopWhenNoNewEvidence) return 'no_new_evidence';
  if (input.round >= input.maxRounds) return 'round_limit';
  return input.remainingTokens < 1 ? 'token_budget' : null;
}

export function deepRoundSummary(input: {
  round: number;
  queries: readonly string[];
  candidateCount: number;
  sufficient: boolean;
}): DeepSearchRound {
  return {
    round: input.round,
    queries: [...input.queries],
    candidateCount: input.candidateCount,
    sufficient: input.sufficient,
  };
}
