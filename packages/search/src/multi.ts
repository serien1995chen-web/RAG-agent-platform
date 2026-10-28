import type { DegradedInfo } from '@kb/contracts';
import { mergeChannelCandidates, stableSortCandidates } from './fusion';
import { DEFAULT_RRF_K } from './rrf';
import type { AuthorizedCandidate, ChannelFailure } from './types';

export interface MultiSpaceSearchSlice {
  knowledgeSpaceId: string;
  candidates?: readonly AuthorizedCandidate[];
  failure?: ChannelFailure;
  partial?: boolean;
  failedChannels?: readonly ChannelFailure[];
}

export interface MultiSpaceMergeResult {
  candidates: AuthorizedCandidate[];
  degraded: DegradedInfo[];
  failedSpaces: string[];
  partial: boolean;
}

function spaceFailureCode(knowledgeSpaceId: string): string {
  return `space_${knowledgeSpaceId}_failed`;
}

export function mergeMultiSpaceCitations(
  slices: readonly MultiSpaceSearchSlice[],
  k: number = DEFAULT_RRF_K,
): MultiSpaceMergeResult {
  const scored: AuthorizedCandidate[] = [];
  const degraded: DegradedInfo[] = [];
  const failedSpaces: string[] = [];
  let partial = false;

  for (const slice of slices) {
    if (!slice.candidates) {
      partial = true;
      failedSpaces.push(slice.knowledgeSpaceId);
      degraded.push({
        stage: 'space',
        reason: spaceFailureCode(slice.knowledgeSpaceId),
      });
      if (slice.failure) {
        degraded.push({
          stage: slice.failure.channel === 'embedding' ? 'vector' : 'fullText',
          reason: slice.failure.degradedCode,
        });
      }
      continue;
    }
    if (slice.partial || (slice.failedChannels?.length ?? 0) > 0) partial = true;
    for (const failure of slice.failedChannels ?? []) {
      degraded.push({
        stage: failure.channel === 'embedding' ? 'vector' : 'fullText',
        reason: failure.degradedCode,
      });
    }
    const ordered = stableSortCandidates(slice.candidates);
    ordered.forEach((candidate, index) => {
      scored.push({
        ...candidate,
        score: 1 / (k + index + 1),
      });
    });
  }

  const merged = mergeChannelCandidates(scored);
  const byKey = new Map<string, AuthorizedCandidate>();
  for (const candidate of merged) {
    const key = `${candidate.knowledgeSpaceId}:${candidate.segmentId}`;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, candidate as AuthorizedCandidate);
      continue;
    }
    byKey.set(key, {
      ...current,
      score: current.score + candidate.score,
      scores: [...current.scores, ...candidate.scores],
    });
  }

  return {
    candidates: stableSortCandidates([...byKey.values()]),
    degraded,
    failedSpaces,
    partial,
  };
}
