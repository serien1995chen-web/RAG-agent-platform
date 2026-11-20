import { describe, expect, it } from 'vitest';
import { mergeExpansions } from '@kb/search';
import { S09SynonymQueryExpansionAdapter } from '../../src/modules/knowledge/adapter/s09-synonym-query-expansion.adapter';
import type { S09PublishedSynonymSnapshot } from '../../src/modules/knowledge/application/s09-synonym.ports';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const spaceId = '65f1e5b2a1c9d4b7e8f09401';
const mapping = {
  logicalMappingId: '65f1e5b2a1c9d4b7e8f09402',
  standardizedTerm: 'Refund',
  normalizedStandardizedTerm: 'refund',
  synonymTerms: ['return'],
  normalizedSynonymTerms: ['return'],
  allTerms: 'Refund return',
  fingerprint: 'a'.repeat(64),
  sourceRows: [2],
};

function context(workspaceId: string, requestId: string): TenantContext {
  return {
    workspaceId,
    memberId: `member-${workspaceId}`,
    requestId,
    traceId: requestId.padEnd(32, '0'),
    scopes: ['knowledge:search'],
  };
}

describe('L1-B16-B-SEARCH-003-C02 synonym cache isolation', () => {
  it('does not share a cached mapping snapshot across workspaces', async () => {
    const snapshots: S09PublishedSynonymSnapshot[] = [
      { knowledgeSpaceId: spaceId, fileVersion: 1, mappings: [mapping] },
      {
        knowledgeSpaceId: spaceId,
        fileVersion: 1,
        mappings: [
          {
            ...mapping,
            standardizedTerm: 'Return merchandise',
            normalizedStandardizedTerm: 'return merchandise',
          },
        ],
      },
    ];
    let snapshotReads = 0;
    let mappingReads = 0;
    const adapter = new S09SynonymQueryExpansionAdapter({
      repository: {
        async getPublishedSnapshot() {
          return snapshots[snapshotReads++] ?? null;
        },
        async assertPublishedVersion() {
          return true;
        },
        async getMappingSnapshot() {
          return snapshots[mappingReads++]?.mappings ?? null;
        },
      },
      mergeExpansions,
    });

    const first = await adapter.expand(
      { query: 'return policy', spaceIds: [spaceId] },
      context('workspace-a', 'req-synonym-a'),
    );
    const second = await adapter.expand(
      { query: 'return policy', spaceIds: [spaceId] },
      context('workspace-b', 'req-synonym-b'),
    );

    expect(first.result.expandedQuery).toBe('return policy Refund');
    expect(second.result.expandedQuery).toBe('return policy Return merchandise');
    expect(second.auditSummary.cacheMisses).toBe(1);
  });
});
