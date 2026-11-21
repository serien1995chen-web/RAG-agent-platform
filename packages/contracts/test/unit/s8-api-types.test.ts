import { describe, expect, it } from 'vitest';
import {
  DeepSearchApiRequestSchema,
  DeepSearchApiResponseSchema,
  ImageSearchApiRequestSchema,
  SearchApiRequestSchema,
} from '../../src';

const spaceId = '65f1e5b2a1c9d4b7e8f01234';
const spaceId2 = '65f1e5b2a1c9d4b7e8f01235';
const uploadId = '65f1e5b2a1c9d4b7e8f09999';

describe('TEST-SEARCH-006-BLOCK / TEST-SEARCH-008-BLOCK API contracts', () => {
  it('keeps ImageSearchRequest fields and accepts text-only, image-only and mixed modes', () => {
    const base = {
      knowledgeSpaceId: spaceId,
      query: 'refund flow',
      tokenBudget: 5_000,
      imageUploadIds: [uploadId],
    };
    expect(ImageSearchApiRequestSchema.safeParse(base).success).toBe(true);
    expect(ImageSearchApiRequestSchema.safeParse({ ...base, imageUploadIds: [] }).success).toBe(
      true,
    );
    expect(
      ImageSearchApiRequestSchema.safeParse({
        ...base,
        query: '',
        imageUploadIds: [uploadId],
      }).success,
    ).toBe(true);
    expect(
      ImageSearchApiRequestSchema.safeParse({
        ...base,
        imageUploadIds: Array.from({ length: 11 }, () => uploadId),
      }).success,
    ).toBe(false);
    expect(
      ImageSearchApiRequestSchema.safeParse({ ...base, query: '', imageUploadIds: [] }).success,
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

  it('L1-B17-SEARCH-008-N01 rejects invalid Deep bounds, invalid Space IDs and unknown fields', () => {
    const base = {
      knowledgeSpaceId: spaceId,
      knowledgeSpaceIds: [spaceId],
      query: 'compare policies',
      tokenBudget: 12_000,
      maxRounds: 3,
      roundTokenBudget: 5_000,
    };
    for (const maxRounds of [0, 4, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3']) {
      expect(
        DeepSearchApiRequestSchema.safeParse({ ...base, maxRounds }).success,
        `maxRounds=${String(maxRounds)}`,
      ).toBe(false);
    }
    for (const roundTokenBudget of [
      499,
      20_001,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '5000',
    ]) {
      expect(
        DeepSearchApiRequestSchema.safeParse({ ...base, roundTokenBudget }).success,
        `roundTokenBudget=${String(roundTokenBudget)}`,
      ).toBe(false);
    }
    for (const tokenBudget of [0, 499, 20_001, -1, Number.NaN, Number.POSITIVE_INFINITY, '12000']) {
      expect(
        DeepSearchApiRequestSchema.safeParse({ ...base, tokenBudget }).success,
        `tokenBudget=${String(tokenBudget)}`,
      ).toBe(false);
    }
    expect(DeepSearchApiRequestSchema.safeParse({ ...base, knowledgeSpaceIds: [] }).success).toBe(
      false,
    );
    expect(
      DeepSearchApiRequestSchema.safeParse({
        ...base,
        knowledgeSpaceIds: Array.from({ length: 21 }, (_, index) =>
          (index + 1).toString(16).padStart(24, '0'),
        ),
      }).success,
    ).toBe(false);
    expect(
      DeepSearchApiRequestSchema.safeParse({
        knowledgeSpaceId: spaceId,
        knowledgeSpaceIds: [spaceId],
        query: 'compare policies',
        tokenBudget: 12_000,
        roundTokenBudget: 5_000,
        costBudgetPoints: 0.0000001,
      }).success,
    ).toBe(false);
    expect(
      DeepSearchApiRequestSchema.safeParse({ ...base, knowledgeSpaceIds: [spaceId2] }).success,
    ).toBe(false);
    expect(
      DeepSearchApiRequestSchema.safeParse({ ...base, knowledgeSpaceIds: ['invalid'] }).success,
    ).toBe(false);
    expect(DeepSearchApiRequestSchema.safeParse({ ...base, unexpected: true }).success).toBe(false);
  });

  it('L1-B17-SEARCH-008-P02 accepts explicit AI Points cost budget and response cost usage', () => {
    const request = DeepSearchApiRequestSchema.parse({
      knowledgeSpaceId: spaceId,
      knowledgeSpaceIds: [spaceId],
      query: 'compare policies',
      tokenBudget: 12_000,
      roundTokenBudget: 5_000,
      maxRounds: 3,
      stopWhenNoNewEvidence: true,
      costBudgetPoints: 0.25,
    });
    expect(request.costBudgetPoints).toBe(0.25);
    expect(
      DeepSearchApiRequestSchema.safeParse({
        knowledgeSpaceId: spaceId,
        knowledgeSpaceIds: [spaceId],
        query: 'compare policies',
        tokenBudget: 12_000,
        roundTokenBudget: 5_000,
        costBudgetPoints: Number.POSITIVE_INFINITY,
      }).success,
    ).toBe(false);

    const response = DeepSearchApiResponseSchema.parse({
      searchId: 'search_b17_cost',
      mode: 'multi_space',
      items: [],
      partial: true,
      durationMs: 12,
      degraded: [],
      rerankApplied: false,
      rounds: [
        {
          round: 1,
          queries: ['refund policy'],
          candidateCount: 0,
          sufficient: false,
          inputTokens: 10,
          outputTokens: 2,
          aiPoints: 0.05,
          permissionRevision: 3,
        },
      ],
      stopReason: 'cost_budget',
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        aiPoints: 0.05,
        aiPointsMicros: 50_000,
        costBudgetPoints: 0.25,
        remainingAiPoints: 0.2,
      },
    });
    expect(response.stopReason).toBe('cost_budget');
    expect(response.usage.remainingAiPoints).toBe(0.2);
  });
});
