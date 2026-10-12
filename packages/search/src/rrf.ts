import type { RankedEntry } from './types';

export const DEFAULT_RRF_K = 60;

export function rrfFuseWeighted(
  lists: readonly (readonly RankedEntry[])[],
  k: number = DEFAULT_RRF_K,
): Map<string, { rrf: number; bestByType: Map<string, number> }> {
  const fused = new Map<string, { rrf: number; bestByType: Map<string, number> }>();

  for (const list of lists) {
    for (const entry of list) {
      const contribution = entry.weight * (1 / (k + entry.rank));
      const current = fused.get(entry.id) ?? { rrf: 0, bestByType: new Map<string, number>() };
      current.rrf += contribution;
      const previous = current.bestByType.get(entry.type);
      current.bestByType.set(
        entry.type,
        previous === undefined ? contribution : Math.max(previous, contribution),
      );
      fused.set(entry.id, current);
    }
  }

  return fused;
}
