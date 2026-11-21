import { describe, expect, it } from 'vitest';
import {
  IdempotencyKeyBuffer,
  S8SearchFormSchema,
  buildS8DeepRequest,
  buildS8ImageRequest,
  defaultS8SearchForm,
} from '../../src/forms/s8-search-form';

const spaceId = '65f1e5b2a1c9d4b7e8f01234';
const uploadId = '65f1e5b2a1c9d4b7e8f09999';

describe('TEST-X-DEEP-BUDGET / S8 UI forms', () => {
  it('uses explicit deep defaults 12000 / 5000 / 3 and image limits', () => {
    const defaults = defaultS8SearchForm(spaceId);
    expect(defaults).toMatchObject({
      tokenBudget: 12_000,
      roundTokenBudget: 5_000,
      maxRounds: 3,
      stopWhenNoNewEvidence: true,
    });
    const deep = buildS8DeepRequest({ ...defaults, query: 'compare refund policies' });
    expect(deep.tokenBudget).toBe(12_000);
    expect(deep.maxRounds).toBe(3);
    const image = buildS8ImageRequest({
      ...defaults,
      query: 'refund diagram',
      imageUploadIds: [uploadId],
    });
    expect(image.imageUploadIds).toEqual([uploadId]);
    expect(S8SearchFormSchema.safeParse({ ...defaults, maxRounds: 4 }).success).toBe(false);
    expect(
      S8SearchFormSchema.safeParse({
        ...defaults,
        imageUploadIds: Array.from({ length: 11 }, () => uploadId),
      }).success,
    ).toBe(false);
  });

  it('L1-B17-SEARCH-008-UI02 keeps Deep controls and AI Points budget in the product form contract', () => {
    const defaults = defaultS8SearchForm(spaceId);
    const withCostBudget = {
      ...defaults,
      query: 'compare refund escalation policies',
      costBudgetPoints: 0.25,
    };
    expect(S8SearchFormSchema.safeParse(withCostBudget).success).toBe(true);
    expect(buildS8DeepRequest(withCostBudget)).toMatchObject({
      maxRounds: 3,
      roundTokenBudget: 5_000,
      tokenBudget: 12_000,
      stopWhenNoNewEvidence: true,
      costBudgetPoints: 0.25,
    });
    for (const costBudgetPoints of [0, 0.0000001, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        S8SearchFormSchema.safeParse({
          ...withCostBudget,
          costBudgetPoints,
        }).success,
        `costBudgetPoints=${String(costBudgetPoints)}`,
      ).toBe(false);
    }
  });

  it('reuses an idempotency key only while the request body is unchanged', () => {
    let index = 0;
    const keys = new IdempotencyKeyBuffer(() => `key-${++index}`);
    expect(keys.keyFor({ query: 'one' })).toBe('key-1');
    expect(keys.keyFor({ query: 'one' })).toBe('key-1');
    expect(keys.keyFor({ query: 'two' })).toBe('key-2');
  });

  it('L1-B12-SEARCH-006-P01 builds text-to-image requests without an uploaded image', () => {
    const defaults = defaultS8SearchForm(spaceId);
    expect(() =>
      buildS8ImageRequest({
        ...defaults,
        query: 'refund flow diagram',
        imageUploadIds: [],
      }),
    ).not.toThrow();
  });

  it('L1-B12-SEARCH-006-P02 builds pure-image requests with a blank text query', () => {
    const defaults = defaultS8SearchForm(spaceId);
    expect(() =>
      buildS8ImageRequest({
        ...defaults,
        query: '',
        imageUploadIds: [uploadId],
      }),
    ).not.toThrow();
  });

  it('L1-B12-SEARCH-006-P03 builds mixed text and image requests', () => {
    const defaults = defaultS8SearchForm(spaceId);
    expect(
      buildS8ImageRequest({
        ...defaults,
        query: 'refund flow diagram',
        imageUploadIds: [uploadId],
      }).imageUploadIds,
    ).toEqual([uploadId]);
  });
});
