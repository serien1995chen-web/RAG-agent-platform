import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  AxiosS5HttpTransport,
  S5AiproxyHttpAdapter,
} from '../../src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import type { S5ModelInvocation } from '../../src/modules/knowledge/application/s5-model-gateway.port';
import {
  KNOWLEDGE_VECTOR_PROFILES,
  KnowledgeVectorRepository,
  ensurePgvectorDdl,
} from '../../src/shared/persistence/pgvector';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const requiredNames = [
  'AIPROXY_BASE_URL',
  'AIPROXY_API_TOKEN',
  'B14_AIPROXY_EMBEDDING_SOURCE_MODEL',
  'B14_AIPROXY_EMBEDDING_TARGET_MODEL',
  'B14_AIPROXY_VLM_MODEL',
] as const;

const context = {
  workspaceId: 'ws_b14_real_provider',
  memberId: 'mem_b14_real_provider',
  requestId: 'req_b14_real_provider',
  traceId: 'trace_b14_real_provider',
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:admin'],
} satisfies TenantContext;

const pngDataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';

function required(name: (typeof requiredNames)[number]): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`B14_PROVIDER_REAL_BLOCKED: missing ${name}`);
  return value;
}

function embeddingDimension(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null;
  const rows = (data as { data?: Array<{ embedding?: unknown }> }).data;
  const embedding = rows?.[0]?.embedding;
  return Array.isArray(embedding) ? embedding.length : null;
}

function embeddingsOf(data: unknown): number[][] {
  if (typeof data !== 'object' || data === null) return [];
  const rows = (data as { data?: Array<{ embedding?: unknown }> }).data;
  return (rows ?? []).flatMap((row) =>
    Array.isArray(row.embedding) && row.embedding.every((value) => typeof value === 'number')
      ? [row.embedding as number[]]
      : [],
  );
}

function requiredPostgres(name: 'KB_TEST_PG_URL'): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`B14_PROVIDER_REAL_BLOCKED: missing ${name}`);
  return value;
}

describe('L1-B14 real Provider index generation', () => {
  it('verifies two real text Embedding models and a VLM caption path', async () => {
    const missing = requiredNames.filter((name) => !process.env[name]?.trim());
    expect(missing, `B14_PROVIDER_REAL_BLOCKED: missing ${missing.join(', ')}`).toEqual([]);

    const adapter = new S5AiproxyHttpAdapter({
      baseUrl: required('AIPROXY_BASE_URL'),
      token: required('AIPROXY_API_TOKEN'),
      transport: new AxiosS5HttpTransport(),
    });
    const invoke = (request: S5ModelInvocation) => adapter.invoke(request, context);
    const startedAt = Date.now();
    const source = await invoke({
      kind: 'embedding',
      modelId: required('B14_AIPROXY_EMBEDDING_SOURCE_MODEL'),
      input: [
        { type: 'text', text: '退款将在五个工作日内到账' },
        { type: 'text', text: 'refund settlement takes five business days' },
      ],
      dimension: 1024,
    });
    const target = await invoke({
      kind: 'embedding',
      modelId: required('B14_AIPROXY_EMBEDDING_TARGET_MODEL'),
      input: [{ type: 'text', text: 'switch index model and rebuild vectors' }],
      dimension: 1024,
    });
    const vlm = await invoke({
      kind: 'vlm',
      modelId: required('B14_AIPROXY_VLM_MODEL'),
      messages: [
        {
          role: 'user',
          content: 'Describe the image in one short caption for image indexing.',
        },
      ],
      imageUrls: [pngDataUrl],
      maxOutputTokens: 32,
    });
    const caption = 'A small image used for the B14 caption embedding path.';
    const captionEmbedding = await invoke({
      kind: 'embedding',
      modelId: required('B14_AIPROXY_EMBEDDING_TARGET_MODEL'),
      input: [{ type: 'text', text: caption }],
      dimension: 1024,
    });
    const elapsedMs = Date.now() - startedAt;
    const sourceVectors = embeddingsOf(source.data);
    const targetVectors = embeddingsOf(target.data);
    const captionVectors = embeddingsOf(captionEmbedding.data);
    expect(sourceVectors).toHaveLength(2);
    expect(targetVectors).toHaveLength(1);
    expect(captionVectors).toHaveLength(1);

    const pool = new Pool({ connectionString: requiredPostgres('KB_TEST_PG_URL'), max: 2 });
    await ensurePgvectorDdl(pool);
    const vectors = new KnowledgeVectorRepository(pool);
    const knowledgeSpaceId = randomUUID().replaceAll('-', '').slice(0, 24);
    const sourceId = randomUUID().replaceAll('-', '').slice(0, 24);
    const sourceSegmentId = randomUUID().replaceAll('-', '').slice(0, 24);
    const targetSegmentId = randomUUID().replaceAll('-', '').slice(0, 24);
    const captionSegmentId = randomUUID().replaceAll('-', '').slice(0, 24);
    const sourceModelId = required('B14_AIPROXY_EMBEDDING_SOURCE_MODEL');
    const targetModelId = required('B14_AIPROXY_EMBEDDING_TARGET_MODEL');
    let pgHits: Awaited<ReturnType<KnowledgeVectorRepository['recall']>> = [];
    try {
      await vectors.insert(
        [
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId,
            sourceId,
            segmentId: sourceSegmentId,
            indexId: 'source-text',
            embeddingModelId: sourceModelId,
            dimension: 1024,
            vector: sourceVectors[0]!,
            searchEnabled: true,
            contentHash: createHash('sha256').update('source-text').digest('hex'),
            version: 1,
          },
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId,
            sourceId,
            segmentId: targetSegmentId,
            indexId: 'target-text',
            embeddingModelId: targetModelId,
            dimension: 1024,
            vector: targetVectors[0]!,
            searchEnabled: true,
            contentHash: createHash('sha256').update('target-text').digest('hex'),
            version: 1,
          },
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId,
            sourceId,
            segmentId: captionSegmentId,
            indexId: 'caption',
            embeddingModelId: targetModelId,
            dimension: 1024,
            vector: captionVectors[0]!,
            searchEnabled: true,
            contentHash: createHash('sha256').update(caption).digest('hex'),
            version: 1,
          },
        ],
        context,
      );
      pgHits = await vectors.recall(
        {
          workspaceId: context.workspaceId,
          knowledgeSpaceId,
          sourceIds: [sourceId],
          dimension: 1024,
          embeddingModelId: targetModelId,
          vector: targetVectors[0]!,
          limit: 10,
        },
        context,
      );
      expect(pgHits.map((hit) => hit.segmentId).sort()).toEqual(
        [targetSegmentId, captionSegmentId].sort(),
      );
    } finally {
      for (const profile of KNOWLEDGE_VECTOR_PROFILES) {
        await pool.query(`DELETE FROM ${profile.tableName} WHERE workspace_id = $1`, [
          context.workspaceId,
        ]);
      }
      await pool.end();
    }
    const evidence = {
      testId: 'L1-B14-TRAIN-003/006-P01-REAL',
      candidateSha: process.env.KB_B14_CANDIDATE_SHA ?? null,
      source: {
        modelId: source.data ? required('B14_AIPROXY_EMBEDDING_SOURCE_MODEL') : null,
        status: source.status,
        dimension: embeddingDimension(source.data),
        quantity: source.quantity,
        usage: source.usage,
      },
      target: {
        modelId: required('B14_AIPROXY_EMBEDDING_TARGET_MODEL'),
        status: target.status,
        dimension: embeddingDimension(target.data),
        quantity: target.quantity,
        usage: target.usage,
      },
      vlm: {
        modelId: required('B14_AIPROXY_VLM_MODEL'),
        status: vlm.status,
        quantity: vlm.quantity,
        usage: vlm.usage,
      },
      captionEmbedding: {
        modelId: targetModelId,
        status: captionEmbedding.status,
        dimension: embeddingDimension(captionEmbedding.data),
        quantity: captionEmbedding.quantity,
        usage: captionEmbedding.usage,
      },
      pgVector: {
        stored: 3,
        targetModelHits: pgHits.length,
        targetSegmentIds: pgHits.map((hit) => hit.segmentId).sort(),
      },
      elapsedMs,
    };
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(required('AIPROXY_API_TOKEN'));
    const resultDir = process.env.B14_RESULT_DIR?.trim();
    if (resultDir) {
      await mkdir(resultDir, { recursive: true });
      await writeFile(
        join(resultDir, 'b14-real-provider.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
      );
    }

    for (const result of [source, target, vlm, captionEmbedding]) {
      expect(result.status).toBeGreaterThanOrEqual(200);
      expect(result.status).toBeLessThan(300);
      expect(result.quantity).toBeGreaterThan(0);
    }
    expect(embeddingDimension(source.data)).toBe(1024);
    expect(embeddingDimension(target.data)).toBe(1024);
    expect(embeddingDimension(captionEmbedding.data)).toBe(1024);
  }, 180_000);
});
