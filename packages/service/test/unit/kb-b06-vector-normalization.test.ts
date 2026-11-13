import { describe, expect, it } from 'vitest';
import { KnowledgeVectorRepository } from '../../src/shared/persistence/pgvector/vector-repository';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_b06_vector',
  memberId: 'mem_b06_vector',
  requestId: 'req_b06_vector',
  traceId: 'trace_b06_vector',
  scopes: ['knowledge:write'],
};

describe('B06 vector normalization', () => {
  it('L1-B06-ING-001-P01 stores a unit norm after L2 normalization', async () => {
    const calls: unknown[][] = [];
    const repository = new KnowledgeVectorRepository({
      async query(_sql: string, params: unknown[]) {
        calls.push(params);
        return { rowCount: 1, rows: [] };
      },
    } as never);

    await repository.insert(
      [
        {
          workspaceId: context.workspaceId,
          knowledgeSpaceId: 'space_b06_vector',
          sourceId: 'source_b06_vector',
          segmentId: 'segment_b06_vector',
          indexId: 'default',
          embeddingModelId: 'mock-embedding-768',
          dimension: 768,
          vector: Array.from({ length: 768 }, () => 0.1),
          searchEnabled: true,
          contentHash: 'hash_b06_vector',
          version: 1,
        },
      ],
      context,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[8]).toBe(1);
  });
});
