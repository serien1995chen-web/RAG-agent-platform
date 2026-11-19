import { describe, expect, it } from 'vitest';
import { ImageSearchApiRequestSchema } from '../../src';

const base = {
  knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
  query: 'refund diagram',
  tokenBudget: 5_000,
  similarity: 0.2,
  embeddingWeight: 0.5,
  usingRerank: false,
  rerankWeight: 0.5,
};
const uploadId = '65f1e5b2a1c9d4b7e8f09999';

describe('L1-B12-SEARCH-006 image request contract', () => {
  it('L1-B12-SEARCH-006-P01 accepts text-to-image search without an image upload', () => {
    const parsed = ImageSearchApiRequestSchema.safeParse({
      ...base,
      imageUploadIds: [],
    });
    expect(parsed.success, parsed.success ? undefined : parsed.error.message).toBe(true);
  });

  it('L1-B12-SEARCH-006-P02 accepts pure-image search with a blank text query', () => {
    const parsed = ImageSearchApiRequestSchema.safeParse({
      ...base,
      query: '',
      imageUploadIds: [uploadId],
    });
    expect(parsed.success, parsed.success ? undefined : parsed.error.message).toBe(true);
  });

  it('L1-B12-SEARCH-006-P03 accepts mixed text and image search', () => {
    expect(
      ImageSearchApiRequestSchema.safeParse({
        ...base,
        imageUploadIds: [uploadId],
      }).success,
    ).toBe(true);
  });

  it('L1-B12-SEARCH-006-N01 rejects blank text with no images or with more than ten images', () => {
    expect(
      ImageSearchApiRequestSchema.safeParse({
        ...base,
        query: '   ',
        imageUploadIds: [],
      }).success,
    ).toBe(false);
    expect(
      ImageSearchApiRequestSchema.safeParse({
        ...base,
        query: '',
        imageUploadIds: Array.from({ length: 11 }, () => uploadId),
      }).success,
    ).toBe(false);
  });
});
