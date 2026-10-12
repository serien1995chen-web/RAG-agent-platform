import { describe, expect, it } from 'vitest';
import { DEFAULT_RRF_K, rrfFuseWeighted } from '../../src/rrf';

describe('rrfFuseWeighted', () => {
  it('returns 1/61 for a single rank-one list with full weight', () => {
    const fused = rrfFuseWeighted([[{ id: 'a', rank: 1, weight: 1, type: 'embedding' }]]);
    expect(fused.get('a')?.rrf).toBe(1 / 61);
  });

  it('adds rank-one contributions across three lists to 3/61', () => {
    const fused = rrfFuseWeighted([
      [{ id: 'a', rank: 1, weight: 1, type: 'embedding' }],
      [{ id: 'a', rank: 1, weight: 1, type: 'fullText' }],
      [{ id: 'a', rank: 1, weight: 1, type: 'image' }],
    ]);
    expect(fused.get('a')?.rrf).toBe(1 / 61 + 1 / 61 + 1 / 61);
    expect(fused.get('a')?.rrf).toBe(3 / 61);
  });

  it('uses 1/63 for a single rank-three contribution', () => {
    const fused = rrfFuseWeighted([[{ id: 'b', rank: 3, weight: 1, type: 'embedding' }]]);
    expect(fused.get('b')?.rrf).toBe(1 / 63);
  });

  it('turns off a path with weight zero', () => {
    const fused = rrfFuseWeighted([[{ id: 'a', rank: 1, weight: 0, type: 'embedding' }]]);
    expect(fused.get('a')?.rrf).toBe(0);
  });

  it('uses the full contribution with weight one', () => {
    const fused = rrfFuseWeighted([[{ id: 'a', rank: 2, weight: 1, type: 'embedding' }]]);
    expect(fused.get('a')?.rrf).toBe(1 / 62);
  });

  it('keeps the maximum type score for the same id', () => {
    const fused = rrfFuseWeighted([
      [{ id: 'a', rank: 3, weight: 1, type: 'embedding' }],
      [{ id: 'a', rank: 1, weight: 1, type: 'embedding' }],
    ]);
    expect(fused.get('a')?.bestByType.get('embedding')).toBe(1 / 61);
  });

  it('accumulates the same id across weighted lists', () => {
    const fused = rrfFuseWeighted([
      [{ id: 'a', rank: 1, weight: 0.5, type: 'embedding' }],
      [{ id: 'a', rank: 1, weight: 0.5, type: 'fullText' }],
    ]);
    expect(fused.get('a')?.rrf).toBeCloseTo(1 / 61, 8);
  });

  it('uses the frozen default k', () => {
    expect(DEFAULT_RRF_K).toBe(60);
    const explicit = rrfFuseWeighted([[{ id: 'a', rank: 1, weight: 1, type: 'embedding' }]], 60);
    const implicit = rrfFuseWeighted([[{ id: 'a', rank: 1, weight: 1, type: 'embedding' }]]);
    expect(implicit.get('a')?.rrf).toBe(explicit.get('a')?.rrf);
  });
});
