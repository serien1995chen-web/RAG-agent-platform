import { describe, expect, it } from 'vitest';
import type { SearchRequest } from '@kb/contracts';
import {
  applyTokenBudget,
  expandQuery,
  fallbackSynonymExpansion,
  finalizeSearchCandidates,
  mergeExpansions,
  SYNONYM_QUERY_MAX_CODE_POINTS,
  type AuthorizedCandidate,
  type SynonymExpansionMapping,
} from '../../src/index';

const request: SearchRequest = {
  requestId: 'req-kb-b16-b-search-005',
  workspaceId: 'ws-kb-b16-b-search-005',
  memberId: 'mem-kb-b16-b-search-005',
  knowledgeSpaceIds: ['space-kb-b16-b'],
  textQueries: ['refund'],
  imageQueries: [],
  models: { embeddingModel: 'embedding-1536' },
  searchMode: 'embedding',
  limit: 10,
  maxTokens: 5_000,
  similarity: 0,
};

function candidate(
  id: string,
  input: {
    question?: string;
    answer?: string;
    content?: string;
    imageIdentity?: string;
    score?: number;
    embeddingScore?: number;
    rerankScore?: number;
  } = {},
): AuthorizedCandidate {
  const question = input.question ?? 'Refund policy';
  const answer = input.answer ?? 'Refunds take five days.';
  const content = input.content ?? answer;
  const score = input.score ?? 0.8;
  return {
    docId: `space-kb-b16-b:${id}`,
    segmentId: id,
    sourceId: `source-${id}`,
    knowledgeSpaceId: 'space-kb-b16-b',
    score,
    embeddingScore: input.embeddingScore ?? score,
    ...(input.rerankScore === undefined ? {} : { rerankScore: input.rerankScore }),
    scores: [
      {
        type: input.rerankScore === undefined ? 'embedding' : 'reRank',
        value: input.rerankScore ?? input.embeddingScore ?? score,
        index: 0,
      },
    ],
    text: content,
    ...(input.imageIdentity ? { imageIdentity: input.imageIdentity } : {}),
    segment: {
      id,
      workspaceId: request.workspaceId,
      knowledgeSpaceId: 'space-kb-b16-b',
      sourceId: `source-${id}`,
      sourceVersion: 1,
      order: 0,
      searchEnabled: true,
      question,
      answer,
      content,
      metadata: {},
      indexes: [],
      indexStatus: 'indexed',
      indexErrorCode: null,
      imageBlobRefId: input.imageIdentity ?? null,
      version: 1,
    },
    source: {
      id: `source-${id}`,
      workspaceId: request.workspaceId,
      knowledgeSpaceId: 'space-kb-b16-b',
      name: `Source ${id}`,
      originalUrl: null,
      sourceVersion: 1,
      permissionRevision: 1,
      searchEnabled: true,
      deletedAt: null,
    },
  };
}

function mapping(id: string, standard: string, synonym: string): SynonymExpansionMapping {
  return {
    logicalMappingId: id,
    standardizedTerm: standard,
    normalizedStandardizedTerm: standard.toLowerCase(),
    synonymTerms: [synonym],
    normalizedSynonymTerms: [synonym.toLowerCase()],
  };
}

describe('L1-B16-B-SEARCH-005 FastGPT 4.17.4 post-processing parity', () => {
  it('L1-B16-B-SEARCH-005-P01 uses q plus answer plus exact image identity for dedupe', () => {
    const first = candidate('first', {
      question: 'Refund policy',
      answer: 'Five days',
      content: 'First body',
    });
    const second = candidate('second', {
      question: 'Refund policy',
      answer: 'Five days',
      content: 'Different body',
    });

    const result = finalizeSearchCandidates(request, [first, second], false);

    expect(result.items.map((item) => item.segmentId)).toEqual(['first']);
  });

  it('L1-B16-B-SEARCH-005-P02 preserves full-width and ASCII text as distinct FastGPT keys', () => {
    const fullWidth = candidate('full-width', {
      question: 'ＡＢＣ',
      answer: '',
      content: 'ＡＢＣ',
    });
    const ascii = candidate('ascii', { question: 'ABC', answer: '', content: 'ABC' });

    const result = finalizeSearchCandidates(request, [fullWidth, ascii], false);

    expect(result.items.map((item) => item.segmentId).sort()).toEqual(['ascii', 'full-width']);
  });

  it('L1-B16-B-SEARCH-005-P03 keeps distinct images and text/image boundaries', () => {
    const text = candidate('text', {
      question: 'A red handbag',
      answer: '',
      content: 'A red handbag',
    });
    const firstImage = candidate('first-image', {
      question: '',
      answer: '',
      content: '',
      imageIdentity: 'image-a',
    });
    const secondImage = candidate('second-image', {
      question: '',
      answer: '',
      content: '',
      imageIdentity: 'image-b',
    });

    const result = finalizeSearchCandidates(request, [text, firstImage, secondImage], false);

    expect(result.items.map((item) => item.segmentId).sort()).toEqual([
      'first-image',
      'second-image',
      'text',
    ]);
  });

  it('L1-B16-B-SEARCH-005-P04 filters by the applicable score domain', () => {
    const lowEmbedding = candidate('low-embedding', {
      question: 'Low embedding candidate',
      score: 0.99,
      embeddingScore: 0.1,
    });
    const highEmbedding = candidate('high-embedding', {
      question: 'High embedding candidate',
      score: 0.01,
      embeddingScore: 0.9,
    });

    const result = finalizeSearchCandidates(
      { ...request, similarity: 0.5 },
      [lowEmbedding, highEmbedding],
      false,
    );

    expect(result.items.map((item) => item.segmentId)).toEqual(['high-embedding']);
  });

  it('L1-B16-B-SEARCH-005-P05 trims a fitting citation prefix to the token budget', () => {
    const item = candidate('prefix', { question: 'abcdefghij', answer: '', content: 'abcdefghij' });
    const [trimmed] = applyTokenBudget([item], 4, (text) => [...text].length);

    expect(trimmed?.text).toBe('abcd');
    expect(trimmed?.citationRange).toEqual({ start: 0, end: 4 });
  });
});

describe('L1-B16-B-SEARCH-003 query expansion boundaries', () => {
  it('L1-B16-B-SEARCH-003-P01 preserves the original query and stable fileVersion metadata', () => {
    const result = expandQuery('怎么退钱', [mapping('000000000000000000000001', '退款', '退钱')]);

    expect(result.originalQuery).toBe('怎么退钱');
    expect(result.expandedQuery).toBe('怎么退钱 退款');
    expect(result.appliedMappingIds).toEqual(['000000000000000000000001']);
  });

  it('L1-B16-B-SEARCH-003-N01 accepts exactly 4096 code points and rejects above the limit', () => {
    const prefix = 'x'.repeat(SYNONYM_QUERY_MAX_CODE_POINTS - 8);
    const exact = `${prefix} alias`;
    const accepted = expandQuery(exact, [mapping('000000000000000000000001', 's', 'alias')]);
    const rejected = expandQuery(`${exact}!`, [mapping('000000000000000000000001', 's', 'alias')]);

    expect([...accepted.expandedQuery]).toHaveLength(SYNONYM_QUERY_MAX_CODE_POINTS);
    expect(accepted.fallbackReason).toBeNull();
    expect(rejected.expandedQuery).toBe(`${exact}!`);
    expect(rejected.fallbackReason).toBe('code_point_limit');
  });

  it('L1-B16-B-SEARCH-003-N02 falls back deterministically when vocabulary is unavailable', () => {
    expect(fallbackSynonymExpansion('原问题', 'version_changed')).toMatchObject({
      originalQuery: '原问题',
      expandedQuery: '原问题',
      hits: [],
      appliedMappingIds: [],
      fallbackReason: 'version_changed',
    });
  });

  it('L1-B16-B-SEARCH-003-C01 merges spaces in request order without overwriting', () => {
    const [result] = mergeExpansions({
      queries: ['退款'],
      contexts: [
        {
          knowledgeSpaceId: 'space-b',
          fileVersion: 9,
          mappings: [mapping('000000000000000000000002', 'Banana', '退款')],
        },
        {
          knowledgeSpaceId: 'space-a',
          fileVersion: 3,
          mappings: [mapping('000000000000000000000001', 'Apple', '退款')],
        },
      ],
    });

    expect(result.expandedQuery).toBe('退款 Banana Apple');
    expect(
      result.hits.map(({ knowledgeSpaceId, fileVersion }) => [knowledgeSpaceId, fileVersion]),
    ).toEqual([
      ['space-b', 9],
      ['space-a', 3],
    ]);
  });
});
