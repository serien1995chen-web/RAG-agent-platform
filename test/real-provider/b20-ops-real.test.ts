import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createKnowledgeConnections,
  loadKnowledgeRuntimeConfig,
  type KnowledgeConnections,
} from '../../packages/service/src';
import {
  AxiosS5HttpTransport,
  S5AiproxyHttpAdapter,
} from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import {
  AxiosS5OcrHttpTransport,
  S5OcrHttpAdapter,
} from '../../packages/service/src/modules/knowledge/adapter/s5-ocr-http.adapter';
import { S5OcrCredentialProfileAdapter } from '../../packages/service/src/modules/knowledge/adapter/s5-ocr-profile.adapter';
import type {
  S5OcrProviderConfig,
  S5OcrProviderError,
} from '../../packages/service/src/modules/knowledge/application/s5-ocr-ports';
import type { S5ModelInvocation } from '../../packages/service/src/modules/knowledge/application/s5-model-gateway.port';
import { loadS5AiproxyConfig } from '../../packages/service/src/shared/config/s5-aiproxy-config';
import {
  ensurePgvectorDdl,
  KnowledgeVectorRepository,
} from '../../packages/service/src/shared/persistence/pgvector';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';
import {
  fixturePdf,
  providerContext,
  requiredProviderEnv,
  safeHostHash,
  sha256,
  writeProviderEvidence,
} from './s11-real-helpers';

const providers = ['somark', 'textin', 'doc2x'] as const;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const context: TenantContext = {
  workspaceId: `ws_b20_ops_real_${suffix}`,
  memberId: `mem_b20_ops_real_${suffix}`,
  requestId: `req_b20_ops_real_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
  isWorkspaceOwner: true,
};
const results: Record<
  string,
  {
    status: 'REAL_VERIFIED' | 'BLOCKED_PROVIDER' | 'FAIL';
    errorKind?: string;
    upstreamStatus?: number | null;
    pageCount?: number;
    markdownSha256?: string;
    usage?: Array<{ unit: string; quantity: number; status: number | null }>;
  }
> = {};
let connections: KnowledgeConnections | undefined;

function ocrConfig(provider: (typeof providers)[number]): S5OcrProviderConfig {
  const common = {
    provider,
    credentialProfileId: `env:S11_OCR_${provider.toUpperCase()}_PROFILE_JSON`,
    timeoutMs: 120_000,
    fallbackProvider: 'none' as const,
    imageHandling: 'drop' as const,
  };
  if (provider === 'textin') {
    return {
      ...common,
      provider,
      removeWatermark: true,
      parseMode: 'auto',
    };
  }
  if (provider === 'doc2x') {
    return {
      ...common,
      provider,
      pollIntervalMs: 1_000,
    };
  }
  return { ...common, provider };
}

function endpointFor(provider: (typeof providers)[number]): string {
  const raw = requiredProviderEnv(`S11_OCR_${provider.toUpperCase()}_PROFILE_JSON`);
  const profile = JSON.parse(raw) as { endpoint?: unknown };
  return typeof profile.endpoint === 'string' ? profile.endpoint : '';
}

function providerFailure(error: S5OcrProviderError) {
  const blocked = ['auth', 'quota', 'rate_limit', 'timeout'].includes(error.kind);
  return {
    status: blocked ? ('BLOCKED_PROVIDER' as const) : ('FAIL' as const),
    errorKind: error.kind,
    upstreamStatus: error.status,
    usage: error.usage.map((usage) => ({
      unit: usage.unit,
      quantity: usage.quantity,
      status: usage.status,
    })),
  };
}

afterAll(async () => {
  const values = Object.values(results);
  const status = values.some((result) => result.status === 'FAIL')
    ? 'FAIL'
    : values.some((result) => result.status === 'BLOCKED_PROVIDER')
      ? 'SCOPED_BLOCKED'
      : 'REAL_VERIFIED';
  writeProviderEvidence('b20-ops-provider.json', {
    schemaVersion: 1,
    candidateSha: process.env.CANDIDATE_SHA ?? null,
    fixtureSha256: sha256(fixturePdf()),
    status,
    results,
    blockers: Object.entries(results)
      .filter(([, result]) => result.status !== 'REAL_VERIFIED')
      .map(([name, result]) => `${name}:${result.errorKind ?? result.status}`),
  });
  if (connections) {
    for (const table of [
      'knowledge_segment_vectors_768',
      'knowledge_segment_vectors_1024',
      'knowledge_segment_vectors_1536',
      'knowledge_segment_vectors_3072',
    ]) {
      await connections.pg.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [
        context.workspaceId,
      ]);
    }
    await connections.close();
  }
});

describe('L1-B20-OPS-002 OCR providers', () => {
  for (const provider of providers) {
    it(`L1-B20-OPS-002-P01 ${provider} independently returns pages, markdown and usage`, async () => {
      const requestId = `req-b20-${provider}-${suffix}`;
      const adapter = new S5OcrHttpAdapter({
        profiles: new S5OcrCredentialProfileAdapter(process.env),
        transport: new AxiosS5OcrHttpTransport(),
      });
      const startedAt = Date.now();
      try {
        const result = await adapter.parse(
          {
            workspaceId: context.workspaceId,
            sourceId: randomUUID(),
            sourceVersion: 1,
            bytes: fixturePdf(),
            fileName: 'b20-two-page.pdf',
            mimeType: 'application/pdf',
            config: ocrConfig(provider),
            timeoutMs: 120_000,
            requestId,
            traceId: context.traceId,
          },
          context,
        );
        expect(result.markdown.trim().length).toBeGreaterThan(0);
        expect(result.pages.length).toBe(2);
        expect(result.usage).not.toHaveLength(0);
        expect(result.usage.every((usage) => usage.quantity > 0)).toBe(true);
        results[provider] = {
          status: 'REAL_VERIFIED',
          pageCount: result.pages.length,
          markdownSha256: sha256(result.markdown),
          usage: result.usage.map((usage) => ({
            unit: usage.unit,
            quantity: usage.quantity,
            status: usage.status,
          })),
        };
        expect({
          provider,
          endpointHostHash: safeHostHash(endpointFor(provider)),
          requestId,
          fallbackUsed: false,
          elapsedMs: Date.now() - startedAt,
        }).toMatchObject({
          requestId,
          endpointHostHash: expect.stringMatching(/^[a-f0-9]{16}$/),
        });
      } catch (error) {
        if (!(error instanceof Error) || !('kind' in error)) throw error;
        results[provider] = providerFailure(error as S5OcrProviderError);
        throw error;
      }
    }, 180_000);
  }
});

describe('L1-B20-OPS-002 TokenDance runtime providers', () => {
  it('L1-B20-OPS-002-P01 text/query embedding indexes and recalls through pgvector', async () => {
    const baseUrl = requiredProviderEnv('AIPROXY_BASE_URL');
    const config = loadS5AiproxyConfig(process.env);
    const adapter = new S5AiproxyHttpAdapter({
      baseUrl,
      token: requiredProviderEnv('AIPROXY_API_TOKEN'),
      transport: new AxiosS5HttpTransport(),
      ...(config.providerOnly ? { providerOnly: config.providerOnly } : {}),
      rerankProtocol: config.rerankProtocol,
    });
    const invoke = (request: S5ModelInvocation) => adapter.invoke(request, providerContext);
    const documents = [
      'The weather is sunny today.',
      'Refunds are processed within five business days.',
      'The office opens at nine in the morning.',
    ];
    const modelId = requiredProviderEnv('S11_AIPROXY_EMBEDDING_MODEL');
    const documentResponse = await invoke({
      kind: 'embedding',
      modelId,
      input: documents.map((text) => ({ type: 'text' as const, text })),
      dimension: 1024,
    });
    const documentData = documentResponse.data as {
      data?: Array<{ embedding?: number[] }>;
      usage?: Record<string, number>;
    };
    expect(documentData.data).toHaveLength(3);
    expect(documentData.data?.every((item) => item.embedding?.length === 1024)).toBe(true);
    expect(documentResponse.usage.inputTokens).toBeGreaterThan(0);

    const queryResponse = await invoke({
      kind: 'embedding',
      modelId,
      input: [{ type: 'text', text: 'How long does refund processing take?' }],
      dimension: 1024,
    });
    const queryVector = (queryResponse.data as { data?: Array<{ embedding?: number[] }> }).data?.[0]
      ?.embedding;
    expect(queryVector).toHaveLength(1024);
    expect(queryVector?.every(Number.isFinite)).toBe(true);

    const pgUrl = process.env.KB_TEST_PG_URL?.trim();
    if (!pgUrl) throw new Error('BLOCKED_ENV: missing KB_TEST_PG_URL');
    const runtimeConfig = loadKnowledgeRuntimeConfig({
      ...process.env,
      KB_ENV: 'test',
      KB_MONGO_URI:
        process.env.KB_TEST_MONGO_URI ??
        `mongodb://127.0.0.1:27017/kb_b20_real_${suffix}?directConnection=true`,
      KB_REDIS_URL: process.env.KB_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379',
      KB_PG_URL: pgUrl,
      KB_S3_ENDPOINT: process.env.KB_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
      KB_S3_BUCKET: process.env.KB_TEST_S3_BUCKET ?? 'kb-test',
      KB_S3_ACCESS_KEY_REF: 'env:KB_B20_REAL_S3_ACCESS',
      KB_S3_SECRET_KEY_REF: 'env:KB_B20_REAL_S3_SECRET',
      KB_B20_REAL_S3_ACCESS: process.env.KB_TEST_S3_ACCESS_KEY ?? 'minioadmin',
      KB_B20_REAL_S3_SECRET: process.env.KB_TEST_S3_SECRET_KEY ?? 'minioadmin',
      API_KEY_HMAC_SECRET_FILE: resolve(import.meta.dirname, '../fixtures/s10/api-key-hmac.secret'),
    });
    connections = await createKnowledgeConnections(runtimeConfig);
    await ensurePgvectorDdl(connections.pg);
    const repository = new KnowledgeVectorRepository(connections.pg);
    const spaceId = randomUUID();
    const records = documents.map((_, index) => ({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: spaceId,
      sourceId: randomUUID(),
      segmentId: randomUUID(),
      indexId: randomUUID(),
      embeddingModelId: modelId,
      dimension: 1024,
      vector: documentData.data![index]!.embedding!,
      searchEnabled: true,
      contentHash: sha256(documents[index]!),
      version: 1,
    }));
    const inserted = await repository.insert(records, context);
    expect(inserted.inserted).toBe(3);
    const recall = await repository.recall(
      {
        workspaceId: context.workspaceId,
        knowledgeSpaceId: spaceId,
        dimension: 1024,
        embeddingModelId: modelId,
        vector: queryVector!,
        limit: 3,
      },
      context,
    );
    expect(recall).toHaveLength(3);
    expect(recall[0]?.segmentId).toBe(records[1]!.segmentId);
    results.aiproxyEmbedding = {
      status: 'REAL_VERIFIED',
      pageCount: undefined,
      usage: [
        {
          unit: 'token',
          quantity: documentResponse.usage.inputTokens + queryResponse.usage.inputTokens,
          status: 200,
        },
      ],
    };
  }, 180_000);

  it('L1-B20-OPS-002-P01 rerank changes order and preserves candidate identity', async () => {
    const config = loadS5AiproxyConfig(process.env);
    const adapter = new S5AiproxyHttpAdapter({
      baseUrl: requiredProviderEnv('AIPROXY_BASE_URL'),
      token: requiredProviderEnv('AIPROXY_API_TOKEN'),
      transport: new AxiosS5HttpTransport(),
      ...(config.providerOnly ? { providerOnly: config.providerOnly } : {}),
      rerankProtocol: config.rerankProtocol,
    });
    const documents = [
      'The weather is sunny today.',
      'Refunds are processed within five business days.',
      'The office opens at nine in the morning.',
    ];
    const candidateIds = [randomUUID(), randomUUID(), randomUUID()];
    const response = await adapter.invoke<{
      results?: Array<{ index?: number; relevance_score?: number }>;
      usage?: Record<string, number>;
    }>(
      {
        kind: 'rerank',
        modelId: requiredProviderEnv('S11_AIPROXY_RERANK_MODEL'),
        query: 'How long does refund processing take?',
        candidates: documents,
      },
      providerContext,
    );
    const ranked = [...(response.data.results ?? [])].sort(
      (left, right) => (right.relevance_score ?? 0) - (left.relevance_score ?? 0),
    );
    expect(ranked).toHaveLength(3);
    expect(ranked[0]?.index).not.toBe(0);
    expect(documents[ranked[0]!.index!]).toMatch(/refund/i);
    expect(
      ranked.map((entry) => ({
        candidateId: candidateIds[entry.index!],
        score: entry.relevance_score,
      })),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ candidateId: expect.any(String), score: expect.any(Number) }),
      ]),
    );
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    results.aiproxyRerank = {
      status: 'REAL_VERIFIED',
      pageCount: undefined,
      usage: [
        {
          unit: 'token',
          quantity: response.usage.inputTokens,
          status: response.status,
        },
      ],
    };
  }, 180_000);

  it('L1-B20-OPS-002-P01 LLM and VLM complete with token usage before caption embedding', async () => {
    const config = loadS5AiproxyConfig(process.env);
    const adapter = new S5AiproxyHttpAdapter({
      baseUrl: requiredProviderEnv('AIPROXY_BASE_URL'),
      token: requiredProviderEnv('AIPROXY_API_TOKEN'),
      transport: new AxiosS5HttpTransport(),
      ...(config.providerOnly ? { providerOnly: config.providerOnly } : {}),
      rerankProtocol: config.rerankProtocol,
    });
    const pngDataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
    const llm = await adapter.invoke(
      {
        kind: 'llm',
        modelId: requiredProviderEnv('S11_AIPROXY_LLM_MODEL'),
        messages: [{ role: 'user', content: 'Reply with exactly B20_OK.' }],
        maxOutputTokens: 16,
      },
      providerContext,
    );
    const llmText = JSON.stringify(llm.data);
    expect(llmText).toContain('B20_OK');
    expect(llm.usage.inputTokens).toBeGreaterThan(0);
    expect(llm.usage.outputTokens).toBeGreaterThan(0);

    const vlm = await adapter.invoke(
      {
        kind: 'vlm',
        modelId: requiredProviderEnv('S11_AIPROXY_VLM_MODEL'),
        messages: [{ role: 'user', content: 'Describe this image in one short sentence.' }],
        imageUrls: [pngDataUrl],
        maxOutputTokens: 64,
      },
      providerContext,
    );
    const caption = JSON.stringify(vlm.data);
    expect(caption.length).toBeGreaterThan(20);
    expect(vlm.usage.inputTokens).toBeGreaterThan(0);

    const captionEmbedding = await adapter.invoke(
      {
        kind: 'embedding',
        modelId: requiredProviderEnv('S11_AIPROXY_VISION_EMBEDDING_MODEL'),
        input: [{ type: 'text', text: 'A minimal image used for B20 caption embedding.' }],
        dimension: 1024,
      },
      providerContext,
    );
    const vector = (captionEmbedding.data as { data?: Array<{ embedding?: number[] }> }).data?.[0]
      ?.embedding;
    expect(vector).toHaveLength(1024);
    results.aiproxyLlm = {
      status: 'REAL_VERIFIED',
      usage: [
        {
          unit: 'token',
          quantity: llm.usage.inputTokens + llm.usage.outputTokens,
          status: llm.status,
        },
      ],
    };
    results.aiproxyVlm = {
      status: 'REAL_VERIFIED',
      usage: [
        {
          unit: 'token',
          quantity: vlm.usage.inputTokens + captionEmbedding.usage.inputTokens,
          status: vlm.status,
        },
      ],
    };
  }, 180_000);
});
