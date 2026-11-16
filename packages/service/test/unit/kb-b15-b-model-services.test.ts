import { describe, expect, it, vi } from 'vitest';
import { S7ModelGatewaySearchAdapter } from '../../src/modules/knowledge/adapter/s7-model-gateway-search.adapter';
import { S5ModelGateway } from '../../src/modules/knowledge/application/s5-model-gateway';
import type {
  S5GatewayUsageFact,
  S5ModelGatewayPort,
  S5ModelGatewayRequest,
  S5UsageRecorderPort,
} from '../../src/modules/knowledge/application/s5-model-gateway.port';
import { S5ModelTransportError } from '../../src/modules/knowledge/application/s5-model-gateway.port';
import type {
  ModelCatalogItem,
  ModelCatalogPort,
} from '../../src/modules/knowledge/application/s5-model-ports';
import { S5QaPipelineAdapter } from '../../src/modules/knowledge/application/s5-qa-pipeline';
import {
  S5ProcessingApplication,
  type S5QaPipelinePort,
} from '../../src/modules/knowledge/application/s5-processing.application';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_b15_service',
  memberId: 'mem_b15_service',
  requestId: 'req-b15-service',
  traceId: 'trace-b15-service',
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:search'],
};

class RecordingUsage implements S5UsageRecorderPort {
  readonly facts: S5GatewayUsageFact[] = [];

  async recordInvocationUsage(fact: S5GatewayUsageFact): Promise<boolean> {
    this.facts.push(fact);
    return true;
  }
}

const catalogModels: ModelCatalogItem[] = [
  {
    modelId: 'llm-primary',
    displayName: 'Primary LLM',
    type: 'llm',
    capabilities: ['chat'],
    dimension: null,
    authorized: true,
  },
  {
    modelId: 'llm-fallback',
    displayName: 'Fallback LLM',
    type: 'llm',
    capabilities: ['chat'],
    dimension: null,
    authorized: true,
  },
  {
    modelId: 'embedding-fallback',
    displayName: 'Embedding fallback',
    type: 'embedding',
    capabilities: ['text-embedding', 'dimension:768'],
    dimension: 768,
    authorized: true,
  },
  {
    modelId: 'rerank-primary',
    displayName: 'Primary rerank',
    type: 'rerank',
    capabilities: ['rerank'],
    dimension: null,
    authorized: true,
  },
  {
    modelId: 'vlm-fallback',
    displayName: 'Fallback VLM',
    type: 'vlm',
    capabilities: ['vision'],
    dimension: null,
    authorized: true,
  },
];

const catalog: ModelCatalogPort = {
  async listModels() {
    return catalogModels;
  },
};

function gatewayPort(handler: (request: S5ModelGatewayRequest) => unknown): {
  port: S5ModelGatewayPort;
  calls: S5ModelGatewayRequest[];
} {
  const calls: S5ModelGatewayRequest[] = [];
  return {
    calls,
    port: {
      async invoke<T>(request: S5ModelGatewayRequest) {
        calls.push(request);
        return {
          data: handler(request) as T,
          actualModelId: request.modelId,
          attempts: 1,
          fallbackUsed: false,
          degraded: false,
          usage: { inputTokens: 3, outputTokens: 0, quantity: 3 },
        };
      },
    },
  };
}

describe('L1-B15-B MODEL-003 rerank service boundary', () => {
  it('L1-B15-B-MODEL-003-P01 maps provider indices back to stable candidate IDs and ranks by score', async () => {
    const fake = gatewayPort(() => ({
      results: [
        { index: 1, relevance_score: 0.95 },
        { index: 0, relevance_score: 0.15 },
      ],
    }));
    const adapter = new S7ModelGatewaySearchAdapter({
      gateway: fake.port,
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
      embedding: { modelId: 'embedding-fallback', dimension: 768 },
      rerank: { modelId: 'rerank-primary', dimension: 768 },
    });

    await expect(
      adapter.rerank(
        {
          model: 'rerank-primary',
          query: 'refund policy',
          items: [
            { id: 'candidate-a', text: 'shipping policy', score: 0.7 },
            { id: 'candidate-b', text: 'refund policy', score: 0.6 },
          ],
          options: { timeoutMs: 1_000 },
        },
        context,
      ),
    ).resolves.toEqual([
      { id: 'candidate-b', score: 0.95 },
      { id: 'candidate-a', score: 0.15 },
    ]);
    expect(fake.calls[0]).toMatchObject({
      kind: 'rerank',
      modelId: 'rerank-primary',
      candidates: ['shipping policy', 'refund policy'],
    });
  });

  it('L1-B15-B-MODEL-003-N01 rejects duplicate provider indices instead of emitting duplicate candidates', async () => {
    const fake = gatewayPort(() => ({
      results: [
        { index: 0, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.8 },
      ],
    }));
    const adapter = new S7ModelGatewaySearchAdapter({
      gateway: fake.port,
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
      embedding: { modelId: 'embedding-fallback', dimension: 768 },
      rerank: { modelId: 'rerank-primary', dimension: 768 },
    });

    await expect(
      adapter.rerank(
        {
          model: 'rerank-primary',
          query: 'refund',
          items: [{ id: 'candidate-a', text: 'refund policy', score: 0.5 }],
          options: { timeoutMs: 1_000 },
        },
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_MODEL_OUTPUT_INVALID' } },
    });
  });

  it.each([
    ['negative', [{ index: -1, score: 1 }]],
    ['out-of-range', [{ index: 2, score: 1 }]],
    ['missing-score', [{ index: 0 }]],
    ['non-finite-score', [{ index: 0, score: Number.NaN }]],
  ])(
    'L1-B15-B-MODEL-003-N02..05 rejects %s provider output without silently reordering',
    async (_label, results) => {
      const fake = gatewayPort(() => ({ results }));
      const adapter = new S7ModelGatewaySearchAdapter({
        gateway: fake.port,
        knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
        embedding: { modelId: 'embedding-fallback', dimension: 768 },
        rerank: { modelId: 'rerank-primary', dimension: 768 },
      });

      await expect(
        adapter.rerank(
          {
            model: 'rerank-primary',
            query: 'refund',
            items: [
              { id: 'candidate-a', text: 'refund policy', score: 0.5 },
              { id: 'candidate-b', text: 'shipping policy', score: 0.4 },
            ],
            options: { timeoutMs: 1_000 },
          },
          context,
        ),
      ).rejects.toMatchObject({
        problem: { error: { code: 'KNOWLEDGE_MODEL_OUTPUT_INVALID' } },
      });
    },
  );

  it('L1-B15-B-MODEL-003-N06 rejects 101 candidates and over-budget input before provider work', async () => {
    const usage = new RecordingUsage();
    const adapter = vi.fn(async () => ({
      status: 200,
      data: { results: [] },
      quantity: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    }));
    const gateway = new S5ModelGateway({ catalog, adapter: { invoke: adapter }, usage });

    await expect(
      gateway.invoke({
        kind: 'rerank',
        modelId: 'rerank-primary',
        query: 'refund',
        candidates: Array.from({ length: 101 }, () => 'candidate'),
        workspaceId: context.workspaceId,
        knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
        requestId: context.requestId,
        traceId: context.traceId,
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    await expect(
      gateway.invoke({
        kind: 'rerank',
        modelId: 'rerank-primary',
        query: 'refund',
        candidates: ['x'.repeat(70_000)],
        workspaceId: context.workspaceId,
        knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
        requestId: context.requestId,
        traceId: context.traceId,
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    expect(adapter).not.toHaveBeenCalled();
  });
});

describe('L1-B15-B MODEL-004 generation service boundary', () => {
  it('L1-B15-B-MODEL-004-P01 validates QA output and preserves prompt version and usage', async () => {
    const fake = gatewayPort(() => ({
      choices: [{ message: { content: 'Q1: 退款多久到账？\nA1: 五个工作日。' } }],
    }));
    const qa = new S5QaPipelineAdapter({
      gateway: fake.port,
      resolveModels: async () => ({ llmModelId: 'llm-primary' }),
    });

    await expect(
      qa.generate({
        chunk: { index: 0, text: '退款在五个工作日内到账。', contentHash: 'sha256:chunk-b15' },
        settings: { trainingType: 'qa', chunkSettingMode: 'auto' },
        context,
        workspaceId: context.workspaceId,
        knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
        sourceId: '65f1e5b2a1c9d4b7e8f05678',
      }),
    ).resolves.toMatchObject({
      fallback: 'none',
      promptVersion: 'qa.default@1',
      items: [{ q: '退款多久到账？', a: '五个工作日。', sourceChunkHash: 'sha256:chunk-b15' }],
      usage: { inputTokens: 3, outputTokens: 0 },
    });
    expect(fake.calls[0]).toMatchObject({
      kind: 'llm',
      modelId: 'llm-primary',
      workspaceId: context.workspaceId,
    });
  });

  it('L1-B15-B-MODEL-004-F01 retries generation exactly once after an invalid schema and records both calls', async () => {
    let calls = 0;
    const fake: S5ModelGatewayPort = {
      async invoke<T>(request: S5ModelGatewayRequest) {
        calls += 1;
        return {
          data: {
            choices: [
              {
                message: {
                  content:
                    calls === 1
                      ? '{"unexpected":"payload"}'
                      : 'Q1: 退款多久到账？\nA1: 五个工作日。',
                },
              },
            ],
          } as T,
          actualModelId: request.modelId,
          attempts: 1,
          fallbackUsed: false,
          degraded: false,
          usage: { inputTokens: 3, outputTokens: 2, quantity: 5 },
        };
      },
    };
    const qa = new S5QaPipelineAdapter({
      gateway: fake,
      resolveModels: async () => ({ llmModelId: 'llm-primary' }),
    });

    const result = await qa.generate({
      chunk: { index: 0, text: '退款在五个工作日内到账。', contentHash: 'sha256:chunk-repair' },
      settings: { trainingType: 'qa', chunkSettingMode: 'auto' },
      context,
      workspaceId: context.workspaceId,
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
      sourceId: '65f1e5b2a1c9d4b7e8f05678',
    });

    expect(calls).toBe(2);
    expect(result).toMatchObject({
      fallback: 'none',
      items: [{ q: '退款多久到账？', a: '五个工作日。' }],
      usage: { inputTokens: 6, outputTokens: 4 },
    });
  });

  it('L1-B15-B-MODEL-004-P02 invokes QA once for automatic indexes without fabricating items on failure', async () => {
    const calls: Array<{ trainingType: string; qaPrompt?: string }> = [];
    const qa: S5QaPipelinePort = {
      async generate(input) {
        calls.push({
          trainingType: input.settings.trainingType,
          ...(input.settings.qaPrompt ? { qaPrompt: input.settings.qaPrompt } : {}),
        });
        return {
          items: [
            { q: '自动索引问题', a: '自动索引答案', sourceChunkHash: input.chunk.contentHash },
          ],
          fallback: 'none',
          promptVersion: 'qa.default@1',
          usage: { inputTokens: 1, outputTokens: 1 },
          diagnostics: [],
        };
      },
      dedupe(items) {
        return [...items];
      },
    };
    const processing = new S5ProcessingApplication(qa);

    const result = await processing.process({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
      sourceId: '65f1e5b2a1c9d4b7e8f05678',
      sourceVersion: 1,
      rawText: '退款在五个工作日内到账。',
      artifact: {
        sourceVersion: 1,
        rawTextObjectRef: {
          blobId: 'blob-b15',
          objectKey: 'private/raw/b15.txt',
          purpose: 'source',
          sha256: 'sha256:raw',
          sizeBytes: 1,
        },
        pages: [],
        assets: [],
        diagnostics: [],
        evidence: {
          parserName: 'liteparse',
          parserVersion: 'test',
          providerConfigHash: 'sha256:config',
          rawTextHash: 'sha256:raw',
        },
      },
      settings: {
        trainingType: 'chunk',
        chunkSettingMode: 'auto',
        autoIndexes: true,
        qaPrompt: '只生成可验证的问答',
      },
      context,
    });

    expect(calls).toEqual([{ trainingType: 'qa', qaPrompt: '只生成可验证的问答' }]);
    expect(result.qaItems).toEqual([
      expect.objectContaining({ q: '自动索引问题', a: '自动索引答案' }),
    ]);
    expect(result.evidence).toMatchObject({
      autoIndexPromptVersion: 'qa.default@1',
      autoIndexCount: 1,
      fallbackUsed: false,
    });
  });

  it('L1-B15-B-MODEL-004-C01 keeps concurrent QA outputs bound to their own source chunk', async () => {
    const fake = gatewayPort((request) => {
      const serialized = JSON.stringify(request);
      const marker = serialized.includes('alpha source') ? 'alpha' : 'beta';
      return {
        choices: [{ message: { content: `Q1: ${marker} question\nA1: ${marker} answer` } }],
      };
    });
    const qa = new S5QaPipelineAdapter({
      gateway: fake.port,
      resolveModels: async () => ({ llmModelId: 'llm-primary' }),
    });
    const generate = (marker: 'alpha' | 'beta') =>
      qa.generate({
        chunk: {
          index: marker === 'alpha' ? 0 : 1,
          text: `${marker} source`,
          contentHash: `sha256:${marker}`,
        },
        settings: { trainingType: 'qa', chunkSettingMode: 'auto' },
        context,
        workspaceId: context.workspaceId,
        knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
        sourceId: `65f1e5b2a1c9d4b7e8f0${marker === 'alpha' ? '1111' : '2222'}`,
      });

    const [alpha, beta] = await Promise.all([generate('alpha'), generate('beta')]);
    expect(alpha.items[0]).toMatchObject({
      q: 'alpha question',
      a: 'alpha answer',
      sourceChunkHash: 'sha256:alpha',
    });
    expect(beta.items[0]).toMatchObject({
      q: 'beta question',
      a: 'beta answer',
      sourceChunkHash: 'sha256:beta',
    });
  });
});

describe('L1-B15-B MODEL-006 gateway fallback boundary', () => {
  it('L1-B15-B-MODEL-006-P01 falls back only to the same model type and reports actual model and degraded state', async () => {
    const usage = new RecordingUsage();
    const calls: string[] = [];
    const gateway = new S5ModelGateway({
      catalog,
      usage,
      sleep: async () => undefined,
      adapter: {
        async invoke<T>(request) {
          calls.push(request.modelId);
          if (request.modelId === 'llm-primary') {
            throw new S5ModelTransportError('provider', 503, null, 'upstream_unavailable');
          }
          return {
            data: { choices: [{ message: { content: 'fallback result' } }] } as T,
            status: 200,
            quantity: 4,
            usage: { inputTokens: 3, outputTokens: 1 },
          };
        },
      },
    });

    await expect(
      gateway.invoke({
        kind: 'llm',
        modelId: 'llm-primary',
        messages: [{ role: 'user', content: 'test' }],
        maxOutputTokens: 32,
        workspaceId: context.workspaceId,
        knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
        requestId: context.requestId,
        traceId: context.traceId,
        context,
        fallbackModelIds: ['embedding-fallback', 'llm-fallback'],
      }),
    ).resolves.toMatchObject({
      actualModelId: 'llm-fallback',
      attempts: 2,
      fallbackUsed: true,
      degraded: true,
      usage: { inputTokens: 3, outputTokens: 1, quantity: 4 },
    });
    expect(calls).toEqual(['llm-primary', 'llm-fallback']);
  });

  it('L1-B15-B-MODEL-006-N01 rejects a tenant mismatch before model catalog or adapter access', async () => {
    const listModels = vi.fn(async () => catalogModels);
    const invoke = vi.fn();
    const gateway = new S5ModelGateway({
      catalog: { listModels },
      usage: new RecordingUsage(),
      adapter: { invoke },
    });

    await expect(
      gateway.invoke({
        kind: 'llm',
        modelId: 'llm-primary',
        messages: [{ role: 'user', content: 'test' }],
        maxOutputTokens: 32,
        workspaceId: 'ws-other',
        knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
        requestId: context.requestId,
        traceId: context.traceId,
        context,
      }),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_VALIDATION_FAILED',
          details: { field: 'workspaceId', reason: 'tenant_mismatch' },
        },
      },
    });
    expect(listModels).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
