import { describe, expect, it } from 'vitest';
import { S5ModelGateway } from '../../packages/service/src/modules/knowledge/application/s5-model-gateway';
import type {
  S5GatewayUsageFact,
  S5UsageRecorderPort,
} from '../../packages/service/src/modules/knowledge/application/s5-model-gateway.port';
import { S5ModelTransportError } from '../../packages/service/src/modules/knowledge/application/s5-model-gateway.port';
import type {
  ModelCatalogItem,
  ModelCatalogPort,
} from '../../packages/service/src/modules/knowledge/application/s5-model-ports';
import { S5OcrApplication } from '../../packages/service/src/modules/knowledge/application/s5-ocr.application';
import {
  S5OcrProviderError,
  type S5OcrProviderConfig,
  type S5ProviderUsageFact,
  type S5ProviderUsageRecorderPort,
} from '../../packages/service/src/modules/knowledge/application/s5-ocr-ports';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_s5_fault',
  memberId: 'mem_s5_fault',
  requestId: 'req-s5-fault',
  traceId: 'trace-s5-fault',
  scopes: ['knowledge:write'],
};

const models: ModelCatalogItem[] = [
  {
    modelId: 'primary',
    displayName: 'Primary',
    type: 'llm',
    capabilities: ['chat'],
    dimension: null,
    authorized: true,
  },
  {
    modelId: 'fallback',
    displayName: 'Fallback',
    type: 'llm',
    capabilities: ['chat'],
    dimension: null,
    authorized: true,
  },
];

const catalog: ModelCatalogPort = {
  async listModels() {
    return models;
  },
};

class ModelUsage implements S5UsageRecorderPort {
  facts: S5GatewayUsageFact[] = [];

  get actualFacts() {
    return this.facts.filter((fact) => fact.intent !== true);
  }

  async recordInvocationUsage(fact: S5GatewayUsageFact) {
    this.facts.push(fact);
    return true;
  }
}

function modelRequest(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'llm' as const,
    modelId: 'primary',
    messages: [{ role: 'user', content: 'fault' }],
    maxOutputTokens: 10,
    workspaceId: context.workspaceId,
    knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f10001',
    requestId: context.requestId,
    traceId: context.traceId,
    context,
    fallbackModelIds: ['fallback'],
    ...overrides,
  };
}

describe('S5 model and parse fault gates', () => {
  it('TEST-MODEL-006-BLOCK stops on auth and never falls back', async () => {
    let calls = 0;
    const usage = new ModelUsage();
    const gateway = new S5ModelGateway({
      catalog,
      usage,
      sleep: async () => undefined,
      adapter: {
        async invoke<_T>() {
          calls += 1;
          throw new S5ModelTransportError('auth', 401);
        },
      },
    });
    await expect(gateway.invoke(modelRequest())).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_MODEL_FAILED', retryable: false } },
    });
    expect(calls).toBe(1);
    expect(usage.actualFacts).toHaveLength(1);
    expect(usage.facts).toHaveLength(2);
  });

  it('TEST-MODEL-003-BLOCK bounds 429/503 attempts at three and records each actual call', async () => {
    let calls = 0;
    const usage = new ModelUsage();
    const gateway = new S5ModelGateway({
      catalog,
      usage,
      sleep: async () => undefined,
      adapter: {
        async invoke<_T>() {
          calls += 1;
          throw new S5ModelTransportError('rate_limit', calls === 1 ? 429 : 503);
        },
      },
    });
    await expect(gateway.invoke(modelRequest())).rejects.toBeTruthy();
    expect(calls).toBe(3);
    expect(usage.actualFacts).toHaveLength(3);
    expect(usage.facts).toHaveLength(6);
    expect(usage.facts.every((fact) => fact.quantity === 0)).toBe(true);
  });

  it('TEST-X-OCR-TIMEOUT retries primary then records LiteParse fallback separately', async () => {
    const facts: S5ProviderUsageFact[] = [];
    const usage: S5ProviderUsageRecorderPort = {
      async recordProviderUsage(fact) {
        facts.push(fact);
        return true;
      },
    };
    const config: S5OcrProviderConfig = {
      provider: 'somark',
      credentialProfileId: 'env:OCR_PROFILE',
      timeoutMs: 10_000,
      fallbackProvider: 'liteparse',
      imageHandling: 'upload_to_storage',
    };
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const application = new S5OcrApplication({
      provider: {
        async parse() {
          primaryCalls += 1;
          throw new S5OcrProviderError(
            'timeout',
            null,
            [{ provider: 'somark', unit: 'request', quantity: 1, status: null }],
            true,
            false,
          );
        },
      },
      usage,
      remoteAssets: {
        async fetch() {
          throw new Error('not used');
        },
      },
      assetSink: {
        async putImage() {
          throw new Error('not used');
        },
      },
      sourceGuard: { async assertSource() {} },
      fallbackPdf: async () => {
        fallbackCalls += 1;
        return {
          markdown: 'fallback',
          pages: [{ pageNumber: 1, text: 'fallback', assets: [] }],
          assets: [],
          diagnostics: [],
        };
      },
      sleep: async () => undefined,
    });
    const result = await application.parse({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f10001',
      sourceId: '65f1e5b2a1c9d4b7e8f10002',
      sourceVersion: 1,
      bytes: Buffer.from('%PDF-1.4'),
      fileName: 'scan.pdf',
      mimeType: 'application/pdf',
      config,
      timeoutMs: 10_000,
      requestId: context.requestId,
      traceId: context.traceId,
      context,
    });
    expect(result.fallbackUsed).toBe(true);
    expect(primaryCalls).toBe(3);
    expect(fallbackCalls).toBe(1);
    expect(facts.map((fact) => fact.provider)).toEqual(['somark', 'somark', 'somark', 'liteparse']);
    expect(facts.at(-1)?.fallbackUsed).toBe(true);
  });
});
