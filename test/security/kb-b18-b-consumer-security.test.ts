import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ImageSearchApiRequestSchema,
  KnowledgeProblemSchema,
  MultiSpaceSearchApiRequestSchema,
  SearchApiRequestSchema,
} from '../../packages/contracts/src';
import { assertSafeTagRegex } from '../../packages/search/src/filter';

const root = resolve(import.meta.dirname, '../..');
const fixtureRoot = join(root, 'test', 'fixtures', 'b18-b');
const consumer = readFileSync(join(fixtureRoot, 'consumer-entry.ts'), 'utf8');
const support = readFileSync(join(fixtureRoot, 'support.ts'), 'utf8');
const page = readFileSync(join(fixtureRoot, 'consumer-page.html'), 'utf8');
const baseRequest = {
  knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
  query: 'refund',
  tokenBudget: 5_000,
};

describe('B18-B downstream dependency and network guard', () => {
  it('forbids service, DAL, database, queue, object store and FastGPT imports', () => {
    for (const source of [consumer]) {
      expect(source).not.toMatch(/@kb\/(?:service|dal|search)/);
      expect(source).not.toMatch(
        /from\s+['"](?:mongoose|mongodb|ioredis|bullmq|pg|minio|@aws-sdk[^'"]*|@fastgpt[^'"]*|@kb-sdk[^'"]*)['"]/,
      );
      expect(source).not.toMatch(/process\.env\.(?:KB_MONGO|KB_REDIS|KB_PG|KB_S3)/);
      expect(source).not.toMatch(/new\s+(?:MongoClient|Redis|Pool|Queue)\b/);
      expect(source).not.toMatch(/\bobjectKey\b/);
    }
    expect(support).not.toContain('@fastgpt-');
  });

  it('sends the key only in the server-side Authorization header', () => {
    expect(consumer).toContain('authorization: `Bearer ${key}`');
    expect(consumer).not.toContain('authorization: key');
    expect(consumer).not.toContain('process.stdout.write(key');
    expect(page).not.toContain('KB_B18_API_KEY');
    expect(page).not.toContain('authorization');
    expect(page).not.toContain('kn_live_');
    const stored = page.match(/sessionStorage\.setItem\([\s\S]*?\);/)?.[0] ?? '';
    expect(stored).toContain('citationIds');
    expect(stored).not.toMatch(/source|content|answer|secret|authorization/i);
    expect(support).toContain('authorization: `Bearer ${input.apiKey}`');
  });

  it('permits only knowledge API and test documents in the browser network surface', () => {
    expect(page).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
    expect(page).toContain('/v1/knowledge/search/multi-space');
    expect(page).toContain('/v1/knowledge/search/semantic');
    expect(page).toContain('/v1/knowledge/search/hybrid');
    expect(page).toContain('/v1/knowledge/citations/');
    expect(support).toContain("url.pathname.startsWith('/v1/knowledge/')");
    expect(support).toContain("url.pathname === '/'");
  });
});

describe('B18-B strict tool and search contracts', () => {
  it.each([
    ['unknown filter field', { ...baseRequest, filters: { rawMongo: { $ne: null } } }],
    [
      'unknown operator',
      {
        ...baseRequest,
        filters: {
          logic: 'AND',
          conditions: [
            {
              tagId: '65f1e5b2a1c9d4b7e8f05678',
              tagType: 'string',
              operator: '$where',
              value: 'sleep(1000)',
            },
          ],
        },
      },
    ],
    ['negative budget', { ...baseRequest, tokenBudget: -1 }],
    ['oversized query', { ...baseRequest, query: 'x'.repeat(20_001) }],
    [
      'file parameter',
      {
        ...baseRequest,
        fileKey: 'dataset/65f1e5b2a1c9d4b7e8f05678/private.pdf',
      },
    ],
    [
      'SSRF-looking source filter',
      { ...baseRequest, filters: { sourceIds: ['http://127.0.0.1'] } },
    ],
  ])('rejects %s before retrieval', (_label, request) => {
    expect(SearchApiRequestSchema.safeParse(request).success).toBe(false);
  });

  it('rejects catastrophic regex at the search-filter safety boundary', () => {
    expect(() => assertSafeTagRegex('(a+)+$')).toThrow('Request validation failed.');
    expect(() => assertSafeTagRegex('^refund-[0-9]{1,4}$')).not.toThrow();
  });

  it('rejects duplicate/invalid Space lists and missing base Space', () => {
    const base = {
      ...baseRequest,
      searchMode: 'hybrid',
    };
    expect(
      MultiSpaceSearchApiRequestSchema.safeParse({
        ...base,
        knowledgeSpaceIds: [base.knowledgeSpaceId],
      }).success,
    ).toBe(true);
    expect(
      MultiSpaceSearchApiRequestSchema.safeParse({
        ...base,
        knowledgeSpaceIds: ['65f1e5b2a1c9d4b7e8f01235'],
      }).success,
    ).toBe(false);
    expect(
      MultiSpaceSearchApiRequestSchema.safeParse({
        ...base,
        knowledgeSpaceIds: [],
      }).success,
    ).toBe(false);
    expect(
      MultiSpaceSearchApiRequestSchema.safeParse({
        ...base,
        knowledgeSpaceIds: Array.from(
          { length: 21 },
          (_, index) => `65f1e5b2a1c9d4b7e8f0${String(index + 1).padStart(4, '0')}`,
        ),
      }).success,
    ).toBe(false);
  });

  it('rejects non-upload file parameters on image search', () => {
    expect(
      ImageSearchApiRequestSchema.safeParse({
        ...baseRequest,
        imageUploadIds: [],
        imageUrl: 'file:///etc/passwd',
      }).success,
    ).toBe(false);
    expect(
      ImageSearchApiRequestSchema.safeParse({
        ...baseRequest,
        imageUploadIds: Array.from({ length: 11 }, (_, index) => `upload-${index}`),
      }).success,
    ).toBe(false);
  });

  it('keeps a stable secret-free Problem envelope', () => {
    const problem = {
      success: false,
      error: {
        code: 'KNOWLEDGE_FORBIDDEN',
        message: 'forbidden',
        retryable: false,
        details: { reason: 'api_key_space_scope' },
      },
      traceId: 'a'.repeat(32),
      requestId: 'req-b18b',
    };
    expect(KnowledgeProblemSchema.safeParse(problem).success).toBe(true);
    expect(JSON.stringify(problem)).not.toMatch(/kn_live_|Authorization|objectKey/);
  });

  it('does not introduce FastGPT datasetIds aliases', () => {
    expect(consumer).not.toContain('datasetIds');
    expect(page).not.toContain('datasetIds');
  });
});
