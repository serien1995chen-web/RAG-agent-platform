import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KnowledgeVectorRepository,
  ensurePgvectorDdl,
} from '../../src/shared/persistence/pgvector';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s7_vector_${suffix}`;
const knowledgeSpaceId = randomUUID();
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s7_vector_${suffix}`,
  requestId: `req-s7-vector-${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:search'],
};

let pool: Pool;
let repository: KnowledgeVectorRepository;

beforeAll(async () => {
  pool = new Pool({ connectionString: requiredEnv('KB_TEST_PG_URL'), max: 4 });
  await ensurePgvectorDdl(pool);
  repository = new KnowledgeVectorRepository(pool);
}, 30_000);

afterAll(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM knowledge_segment_vectors_1536 WHERE workspace_id = $1', [
    workspaceId,
  ]);
  await pool.end();
});

describe('TEST-SEARCH-001-BLOCK pgvector cosine recall', () => {
  it('sets scoped cosine recall order and ignores disabled vectors', async () => {
    const sourceId = randomUUID();
    const exactSegment = randomUUID();
    const otherSegment = randomUUID();
    const vector = (axis: number) =>
      Array.from({ length: 1536 }, (_, index) => (index === axis ? 1 : 0));
    await repository.insert(
      [
        {
          workspaceId,
          knowledgeSpaceId,
          sourceId,
          segmentId: exactSegment,
          indexId: 'idx-exact',
          embeddingModelId: 'mock-embedding-1536',
          dimension: 1536,
          vector: vector(0),
          searchEnabled: true,
          contentHash: createHash('sha256').update('exact').digest('hex'),
          version: 1,
        },
        {
          workspaceId,
          knowledgeSpaceId,
          sourceId,
          segmentId: otherSegment,
          indexId: 'idx-other',
          embeddingModelId: 'mock-embedding-1536',
          dimension: 1536,
          vector: vector(1),
          searchEnabled: false,
          contentHash: createHash('sha256').update('other').digest('hex'),
          version: 1,
        },
      ],
      context,
    );
    const hits = await repository.recall(
      {
        workspaceId,
        knowledgeSpaceId,
        dimension: 1536,
        embeddingModelId: 'mock-embedding-1536',
        vector: vector(0),
        limit: 100,
      },
      context,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      workspaceId,
      knowledgeSpaceId,
      sourceId,
      segmentId: exactSegment,
      indexId: 'idx-exact',
      version: 1,
    });
    expect(hits[0]!.score).toBeGreaterThan(0.999);
  });
});
