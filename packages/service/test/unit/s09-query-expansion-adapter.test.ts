import { describe, expect, it } from 'vitest';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';
import type { SynonymMapping } from '../../src/modules/knowledge/domain/s09-synonym';
import type { S09PublishedSynonymSnapshot } from '../../src/modules/knowledge/application/s09-synonym.ports';
import { S09SynonymQueryExpansionAdapter } from '../../src/modules/knowledge/adapter/s09-synonym-query-expansion.adapter';
import { mergeExpansions } from '../../../search/src/synonym-expansion';

const context: TenantContext = {
  workspaceId: 'ws_s9_query',
  memberId: 'mem_s9_query',
  requestId: 'req_s9_query',
  traceId: 'trace_s9_query'.padEnd(32, '0'),
};

function mapping(logicalMappingId: string, standard: string, synonym: string): SynonymMapping {
  return {
    logicalMappingId,
    standardizedTerm: standard,
    normalizedStandardizedTerm: standard.toLowerCase(),
    synonymTerms: [synonym],
    normalizedSynonymTerms: [synonym.toLowerCase()],
    allTerms: `${standard} ${synonym}`,
    fingerprint: 'a'.repeat(64),
    sourceRows: [2],
  };
}

function snapshot(
  spaceId: string,
  version: number,
  value: SynonymMapping,
): S09PublishedSynonymSnapshot {
  return { knowledgeSpaceId: spaceId, fileVersion: version, mappings: [value] };
}

describe('S9 synonym query expansion adapter', () => {
  it('TEST-SEARCH-003-BLOCK checks Mongo on every cache hit and keeps cache keys tenant-scoped', async () => {
    const calls = {
      snapshots: 0,
      assertions: 0,
      mappings: 0,
    };
    const snapshotValue = snapshot(
      'space-a',
      3,
      mapping('000000000000000000000001', 'Refund', 'return'),
    );
    const adapter = new S09SynonymQueryExpansionAdapter({
      repository: {
        async getPublishedSnapshot() {
          calls.snapshots += 1;
          return snapshotValue;
        },
        async assertPublishedVersion() {
          calls.assertions += 1;
          return true;
        },
        async getMappingSnapshot() {
          calls.mappings += 1;
          return snapshotValue.mappings;
        },
      },
      mergeExpansions,
    });
    const first = await adapter.expand({ query: 'return policy', spaceIds: ['space-a'] }, context);
    const second = await adapter.expand({ query: 'return policy', spaceIds: ['space-a'] }, context);
    expect(first.result.expandedQuery).toBe('return policy Refund');
    expect(first.auditSummary.cacheMisses).toBe(1);
    expect(second.auditSummary.cacheHits).toBe(1);
    expect(calls).toEqual({ snapshots: 2, assertions: 3, mappings: 1 });
    expect(JSON.stringify(second.auditSummary)).not.toContain('return');
  });

  it('TEST-SEARCH-003-BLOCK falls back to the original query on version change or repository failure', async () => {
    let valid = false;
    const adapter = new S09SynonymQueryExpansionAdapter({
      repository: {
        async getPublishedSnapshot() {
          return snapshot('space-a', 7, mapping('000000000000000000000001', 'Refund', 'return'));
        },
        async assertPublishedVersion() {
          return valid;
        },
        async getMappingSnapshot() {
          return null;
        },
      },
      mergeExpansions,
    });
    expect(await adapter.expand({ query: 'return', spaceIds: ['space-a'] }, context)).toMatchObject(
      {
        result: { expandedQuery: 'return', fallbackReason: 'version_changed' },
      },
    );
    valid = true;
    const unavailable = new S09SynonymQueryExpansionAdapter({
      repository: {
        async getPublishedSnapshot() {
          throw new Error('mongo unavailable');
        },
        async assertPublishedVersion() {
          return true;
        },
        async getMappingSnapshot() {
          return null;
        },
      },
      mergeExpansions,
    });
    expect(
      await unavailable.expand({ query: 'return', spaceIds: ['space-a'] }, context),
    ).toMatchObject({
      result: { expandedQuery: 'return', fallbackReason: 'safety' },
    });
  });

  it('TEST-SEARCH-003-BLOCK merges authorized spaces in request order', async () => {
    const snapshots = new Map([
      ['space-b', snapshot('space-b', 2, mapping('000000000000000000000002', 'Banana', 'refund'))],
      ['space-a', snapshot('space-a', 1, mapping('000000000000000000000001', 'Apple', 'refund'))],
    ]);
    const adapter = new S09SynonymQueryExpansionAdapter({
      repository: {
        async getPublishedSnapshot(spaceId) {
          return snapshots.get(spaceId) ?? null;
        },
        async assertPublishedVersion() {
          return true;
        },
        async getMappingSnapshot(spaceId) {
          return snapshots.get(spaceId)?.mappings ?? null;
        },
      },
      mergeExpansions,
    });
    const result = await adapter.expand(
      { query: 'refund', spaceIds: ['space-b', 'space-a'] },
      context,
    );
    expect(result.result.expandedQuery).toBe('refund Banana Apple');
    expect(result.auditSummary.spaces.map((space) => space.knowledgeSpaceId)).toEqual([
      'space-b',
      'space-a',
    ]);
  });

  it('TEST-SEARCH-003-BLOCK falls back once when a cached fileVersion changes', async () => {
    let version = 1;
    const adapter = new S09SynonymQueryExpansionAdapter({
      repository: {
        async getPublishedSnapshot() {
          return snapshot(
            'space-a',
            version,
            mapping('000000000000000000000001', 'Refund', 'return'),
          );
        },
        async assertPublishedVersion() {
          return true;
        },
        async getMappingSnapshot() {
          return [mapping('000000000000000000000001', 'Refund', 'return')];
        },
      },
      mergeExpansions,
    });
    await adapter.expand({ query: 'return', spaceIds: ['space-a'] }, context);
    version = 2;
    expect(await adapter.expand({ query: 'return', spaceIds: ['space-a'] }, context)).toMatchObject(
      {
        result: { expandedQuery: 'return', fallbackReason: 'cache_mismatch' },
      },
    );
    expect(await adapter.expand({ query: 'return', spaceIds: ['space-a'] }, context)).toMatchObject(
      {
        result: { expandedQuery: 'return Refund', fallbackReason: null },
      },
    );
  });

  it('TEST-SEARCH-003-BLOCK falls back to the original query when disabled', async () => {
    const adapter = new S09SynonymQueryExpansionAdapter({
      repository: {
        async getPublishedSnapshot() {
          return null;
        },
        async getConfig() {
          return {
            knowledgeSpaceId: 'space-a',
            fileName: 'synonyms.csv',
            sizeBytes: 10,
            activeFileVersion: 1,
            enabled: false,
            schemaVersion: 2 as const,
            status: 'disabled' as const,
            mappingCount: 1,
            termCount: 2,
            version: 2,
            updatedAt: '2026-10-28T12:00:00.000Z',
            lastError: null,
          };
        },
        async assertPublishedVersion() {
          return false;
        },
        async getMappingSnapshot() {
          return null;
        },
      },
      mergeExpansions,
    });
    expect(await adapter.expand({ query: 'return', spaceIds: ['space-a'] }, context)).toMatchObject(
      {
        result: { expandedQuery: 'return', fallbackReason: 'disabled' },
      },
    );
  });

  it('TEST-SEARCH-003-BLOCK falls back above 4096 code points', async () => {
    const adapter = new S09SynonymQueryExpansionAdapter({
      repository: {
        async getPublishedSnapshot() {
          return snapshot('space-a', 1, mapping('000000000000000000000001', 'Standard', 'alias'));
        },
        async assertPublishedVersion() {
          return true;
        },
        async getMappingSnapshot() {
          return [mapping('000000000000000000000001', 'Standard', 'alias')];
        },
      },
      mergeExpansions,
    });
    const query = `${'x'.repeat(4085)} alias`;
    expect(await adapter.expand({ query, spaceIds: ['space-a'] }, context)).toMatchObject({
      result: { expandedQuery: query, fallbackReason: 'code_point_limit' },
    });
  });
});
