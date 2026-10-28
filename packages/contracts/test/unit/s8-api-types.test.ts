import { describe, expect, it } from 'vitest';
import {
  DeepSearchApiRequestSchema,
  ImageSearchApiRequestSchema,
  SearchApiRequestSchema,
} from '../../src';

const spaceId = '65f1e5b2a1c9d4b7e8f01234';
const spaceId2 = '65f1e5b2a1c9d4b7e8f01235';
const uploadId = '65f1e5b2a1c9d4b7e8f09999';

describe('TEST-SEARCH-006-BLOCK / TEST-SEARCH-008-BLOCK API contracts', () => {
  it('keeps ImageSearchRequest fields and requires 1-10 images', () => {
    const base = {
      knowledgeSpaceId: spaceId,
      query: 'refund flow',
      tokenBudget: 5_000,
      imageUploadIds: [uploadId],
    };
    expect(ImageSearchApiRequestSchema.safeParse(base).success).toBe(true);
    expect(ImageSearchApiRequestSchema.safeParse({ ...base, imageUploadIds: [] }).success).toBe(
      false,
    );
    expect(
      ImageSearchApiRequestSchema.safeParse({
        ...base,
        imageUploadIds: Array.from({ length: 11 }, () => uploadId),
      }).success,
    ).toBe(false);
    expect(SearchApiRequestSchema.keyof().options).not.toContain('imageUploadIds');
  });

  it('locks Deep maxRounds to 3, defaults round budget and keeps tokenBudget required', () => {
    const base = {
      knowledgeSpaceId: spaceId,
      knowledgeSpaceIds: [spaceId, spaceId2],
      query: 'compare policies',
      tokenBudget: 12_000,
      maxRounds: 3,
      roundTokenBudget: 5_000,
      stopWhenNoNewEvidence: true,
    };
    const parsed = DeepSearchApiRequestSchema.parse(base);
    expect(parsed.maxRounds).toBe(3);
    expect(parsed.roundTokenBudget).toBe(5_000);
    expect(parsed.stopWhenNoNewEvidence).toBe(true);
    expect(DeepSearchApiRequestSchema.safeParse({ ...base, maxRounds: 4 }).success).toBe(false);
    expect(DeepSearchApiRequestSchema.safeParse({ ...base, roundTokenBudget: 499 }).success).toBe(
      false,
    );
    expect(DeepSearchApiRequestSchema.safeParse({ ...base, tokenBudget: undefined }).success).toBe(
      false,
    );
  });
});
