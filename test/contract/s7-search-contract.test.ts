import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFERRED_OPERATION_MANIFEST,
  MultiSpaceSearchApiRequestSchema,
  SearchApiRequestSchema,
  SearchApiResponseSchema,
  SearchFilterApiSchema,
  SearchRequestSchema,
  toPipelineSearchRequest,
} from '../../packages/contracts/src/index';

const root = resolve(import.meta.dirname, '../..');
const spaceId = '65f1e5b2a1c9d4b7e8f01234';
const S7_OPERATIONS = [
  'API-SEARCH-SEMANTIC',
  'API-SEARCH-FULLTEXT',
  'API-SEARCH-HYBRID',
  'API-SEARCH-MULTI',
  'API-CITATION-GET',
] as const;

describe('TEST-SEARCH-001/002/004/005/007/009-BLOCK S7 contract gate', () => {
  it('keeps all five operations deferred and absent from public runtime/navigation', () => {
    const runtime = JSON.parse(
      readFileSync(
        resolve(root, 'packages/contracts/src/openapi/runtime-registry.data.json'),
        'utf8',
      ),
    ) as { operations?: string[] } | string[];
    const deferred = DEFERRED_OPERATION_MANIFEST.map((entry) => entry.operationId);
    const runtimeIds = Array.isArray(runtime) ? runtime : (runtime.operations ?? []);
    expect(runtimeIds).not.toEqual(expect.arrayContaining([...S7_OPERATIONS]));
    expect(deferred).toEqual(expect.arrayContaining([...S7_OPERATIONS]));
    expect(existsSync(resolve(root, 'projects/app/src/pages/spaces/[spaceId]/search.tsx'))).toBe(
      false,
    );
    const shell = readFileSync(
      resolve(root, 'packages/web/src/components/knowledge-shell.tsx'),
      'utf8',
    );
    expect(shell).not.toContain('/search');
  });

  it('keeps route mode, body mode and strict public fields closed', () => {
    expect(
      SearchApiRequestSchema.safeParse({
        knowledgeSpaceId: spaceId,
        query: 'refund',
        tokenBudget: 5_000,
        unknown: true,
      }).success,
    ).toBe(false);
    const parsed = SearchApiRequestSchema.parse({
      knowledgeSpaceId: spaceId,
      query: 'refund',
      tokenBudget: 5_000,
      searchMode: 'semantic',
    });
    const pipeline = toPipelineSearchRequest(parsed, {
      requestId: 'req-contract',
      workspaceId: 'ws-contract',
      memberId: 'mem-contract',
      models: { embeddingModel: 'embedding-1536' },
      mode: 'semantic',
    });
    expect(SearchRequestSchema.parse(pipeline)).toMatchObject({
      searchMode: 'embedding',
      textQueries: ['refund'],
      maxTokens: 5_000,
    });
  });

  it('keeps SearchFilter and MultiSpace limits strict', () => {
    expect(
      SearchFilterApiSchema.safeParse({
        logic: 'AND',
        conditions: Array.from({ length: 65 }, () => ({
          tagId: '65f1e5b2a1c9d4b7e8f0aaaa',
          tagType: 'string',
          operator: '$empty',
        })),
      }).success,
    ).toBe(false);
    expect(
      MultiSpaceSearchApiRequestSchema.safeParse({
        knowledgeSpaceId: spaceId,
        knowledgeSpaceIds: [spaceId],
        query: 'refund',
        tokenBudget: 5_000,
      }).success,
    ).toBe(true);
  });

  it('exposes only S7 response additions and no citation expiry/object key', () => {
    const parsed = SearchApiResponseSchema.parse({
      searchId: 'search_contract',
      mode: 'semantic',
      items: [],
      partial: false,
      durationMs: 1,
      degraded: [],
      rerankApplied: false,
    });
    expect(parsed.items).toEqual([]);
    const openapi = JSON.parse(
      readFileSync(
        resolve(root, 'packages/contracts/openapi/knowledge-target.openapi.json'),
        'utf8',
      ),
    ) as {
      paths: Record<
        string,
        {
          get?: {
            operationId?: string;
            'x-audit'?: boolean;
          };
        }
      >;
    };
    const citation = openapi.paths['/v1/knowledge/citations/{citationId}']?.get;
    expect(citation?.operationId).toBe('API-CITATION-GET');
    expect(citation?.['x-audit']).toBe(false);
  });
});
