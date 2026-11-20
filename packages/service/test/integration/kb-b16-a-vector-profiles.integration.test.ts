import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KnowledgeVectorRepository,
  ensurePgvectorDdl,
} from '../../src/shared/persistence/pgvector';
import {
  KNOWLEDGE_VECTOR_PROFILES,
  vectorProfileOfDimension,
} from '../../src/shared/persistence/pgvector/ddl';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';
import { B16_SEGMENTS, deterministicVector } from '../../../../test/fixtures/kb-b16-a/corpus';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required test environment: ${name}`);
  return value;
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_kb_b16_a_${suffix}`;
const knowledgeSpaceId = randomUUID();
const context: TenantContext = {
  workspaceId,
  memberId: `mem_kb_b16_a_${suffix}`,
  requestId: `req-kb-b16-a-${suffix}`,
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
  for (const profile of KNOWLEDGE_VECTOR_PROFILES) {
    await pool.query(`DELETE FROM ${profile.tableName} WHERE workspace_id = $1`, [workspaceId]);
  }
  await pool.end();
});

describe('B16 codexA real pgvector profiles', () => {
  for (const profile of KNOWLEDGE_VECTOR_PROFILES) {
    it(`L1-B16-A-SEARCH-001-P${String(profile.dimension).padStart(2, '0')} recalls ${profile.dimension} ${profile.storageType} with the expected cosine score`, async () => {
      const target = B16_SEGMENTS[0]!;
      const other = B16_SEGMENTS[1]!;
      const modelId = `kb-b16-a-embedding-${profile.dimension}`;
      await repository.insert(
        [
          {
            workspaceId,
            knowledgeSpaceId,
            sourceId: target.sourceId,
            segmentId: target.segmentId,
            indexId: `idx-${profile.dimension}-target`,
            embeddingModelId: modelId,
            dimension: profile.dimension,
            vector: deterministicVector(profile.dimension, 0),
            searchEnabled: true,
            contentHash: createHash('sha256').update(target.text).digest('hex'),
            version: 1,
          },
          {
            workspaceId,
            knowledgeSpaceId,
            sourceId: other.sourceId,
            segmentId: other.segmentId,
            indexId: `idx-${profile.dimension}-other`,
            embeddingModelId: modelId,
            dimension: profile.dimension,
            vector: deterministicVector(profile.dimension, 1),
            searchEnabled: false,
            contentHash: createHash('sha256').update(other.text).digest('hex'),
            version: 1,
          },
        ],
        context,
      );
      const hits = await repository.recall(
        {
          workspaceId,
          knowledgeSpaceId,
          dimension: profile.dimension,
          embeddingModelId: modelId,
          vector: deterministicVector(profile.dimension, 0),
          limit: 100,
        },
        context,
      );
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        workspaceId,
        knowledgeSpaceId,
        sourceId: target.sourceId,
        segmentId: target.segmentId,
        version: 1,
      });
      expect(hits[0]?.score).toBeCloseTo(1, 5);
      expect(vectorProfileOfDimension(profile.dimension)).toMatchObject({
        storageType: profile.dimension === 3072 ? 'halfvec' : 'vector',
        opclass: profile.dimension === 3072 ? 'halfvec_cosine_ops' : 'vector_cosine_ops',
      });
    }, 30_000);
  }

  it('L1-B16-A-SEARCH-001-S01 exposes the real vector/halfvec column and HNSW opclass', async () => {
    const metadata = await pool.query<{
      table_name: string;
      data_type: string;
      opclass: string | null;
    }>(
      `
      SELECT c.relname AS table_name, t.typname AS data_type,
             opc.opcname AS opclass
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'embedding'
      JOIN pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisvalid
      LEFT JOIN pg_opclass opc ON opc.oid = i.indclass[0]
      WHERE c.relname = ANY($1::text[])
      ORDER BY c.relname, opc.opcname
    `,
      [KNOWLEDGE_VECTOR_PROFILES.map((profile) => profile.tableName)],
    );
    const byTable = new Map(
      metadata.rows.map((row) => [
        row.table_name,
        { dataType: row.data_type, opclasses: [] as string[] },
      ]),
    );
    for (const row of metadata.rows) {
      if (row.opclass) byTable.get(row.table_name)?.opclasses.push(row.opclass);
    }
    expect(byTable.get('knowledge_segment_vectors_3072')?.dataType).toBe('halfvec');
    expect(byTable.get('knowledge_segment_vectors_3072')?.opclasses).toContain(
      'halfvec_cosine_ops',
    );
    for (const dimension of [768, 1024, 1536]) {
      expect(byTable.get(`knowledge_segment_vectors_${dimension}`)?.dataType).toBe('vector');
      expect(byTable.get(`knowledge_segment_vectors_${dimension}`)?.opclasses).toContain(
        'vector_cosine_ops',
      );
    }
  });

  it('L1-B16-A-SEARCH-001-N01 rejects a query vector with the wrong dimension before recall', async () => {
    await expect(
      repository.recall(
        {
          workspaceId,
          knowledgeSpaceId,
          dimension: 1536,
          embeddingModelId: 'kb-b16-a-embedding-1536',
          vector: deterministicVector(1024, 0),
          limit: 100,
        },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
  });
});
