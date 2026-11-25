import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDefaultTemplateRegistry,
  generateQa,
  type QaModelInput,
  type QaModelPort,
} from '../../packages/qa/src/index';
import {
  AxiosS5HttpTransport,
  S5AiproxyHttpAdapter,
  type S5HttpRequest,
} from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import { S5ModelGateway } from '../../packages/service/src/modules/knowledge/application/s5-model-gateway';
import type {
  S5GatewayUsageFact,
  S5UsageRecorderPort,
} from '../../packages/service/src/modules/knowledge/application/s5-model-gateway.port';
import type { ModelCatalogPort } from '../../packages/service/src/modules/knowledge/application/s5-model-ports';
import { S5QaPipelineAdapter } from '../../packages/service/src/modules/knowledge/application/s5-qa-pipeline';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';
import {
  requiredProviderEnv,
  safeHostHash,
  sha256,
  writeProviderEvidence,
} from './s11-real-helpers';

const root = resolve(import.meta.dirname, '../..');
const corpus = JSON.parse(
  readFileSync(join(root, 'test', 'fixtures', 'b11-b', 'corpus.json'), 'utf8'),
) as Record<string, string>;

const context: TenantContext = {
  workspaceId: 'ws_b11_a2_real_qa',
  memberId: 'mem_b11_a2_real_qa',
  requestId: 'req-b11-a2-real-qa',
  traceId: 'trace-b11-a2-real-qa',
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
};

class Usage implements S5UsageRecorderPort {
  readonly facts: S5GatewayUsageFact[] = [];

  async recordInvocationUsage(fact: S5GatewayUsageFact) {
    this.facts.push(fact);
    return true;
  }
}

function env() {
  return {
    baseUrl: requiredProviderEnv('AIPROXY_BASE_URL'),
    token: requiredProviderEnv('AIPROXY_API_TOKEN'),
    modelId: process.env.B11_B_REAL_LLM_MODEL_ID?.trim() || 'deepseek-v4.1-flash',
  };
}

function catalogFor(modelId: string): ModelCatalogPort {
  return {
    async listModels() {
      return [
        {
          modelId,
          displayName: modelId,
          type: 'llm' as const,
          capabilities: ['chat'],
          dimension: null,
          authorized: true,
        },
      ];
    },
  };
}

class CountingTransport extends AxiosS5HttpTransport {
  calls = 0;
  readonly requests: S5HttpRequest[] = [];

  override async request<T = unknown>(
    input: Parameters<AxiosS5HttpTransport['request']>[0],
  ): Promise<Awaited<ReturnType<AxiosS5HttpTransport['request']>>> {
    this.calls += 1;
    this.requests.push(input);
    return super.request<T>(input);
  }
}

function pipeline(input: { token?: string; modelId: string; transport?: CountingTransport }) {
  const provider = env();
  const transport = input.transport ?? new CountingTransport();
  const usage = new Usage();
  const gateway = new S5ModelGateway({
    catalog: catalogFor(input.modelId),
    adapter: new S5AiproxyHttpAdapter({
      baseUrl: provider.baseUrl,
      token: input.token ?? provider.token,
      transport,
    }),
    usage,
    sleep: async () => undefined,
  });
  return {
    transport,
    usage,
    qa: new S5QaPipelineAdapter({
      gateway,
      qaSchemaRetries: 0,
      resolveModels: async () => ({ llmModelId: input.modelId }),
    }),
  };
}

describe('L1-B11-A2 PARSE-004 real AIProxy QA integration', () => {
  it('L1-B11-A2-PARSE-004-P01R runs a real model through QA validation with traceable usage', async () => {
    const provider = env();
    const transport = new CountingTransport();
    const harness = pipeline({ modelId: provider.modelId, transport });
    const result = await harness.qa.generate({
      chunk: {
        index: 0,
        text: corpus.longParagraph!,
        contentHash: `sha256:${sha256(corpus.longParagraph!)}`,
      },
      settings: {
        trainingType: 'qa',
        chunkSettingMode: 'auto',
        qaPrompt: 'Return one grounded QA pair in exactly Q1: question and A1: answer format.',
      },
      context,
      workspaceId: context.workspaceId,
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f10001',
      sourceId: '65f1e5b2a1c9d4b7e8f10002',
    });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(transport.calls).toBe(1);
    expect(harness.usage.facts.filter((fact) => fact.intent !== true).length).toBeGreaterThan(0);

    writeProviderEvidence('b11-a2-real-qa-valid.json', {
      status: 'REAL_VERIFIED',
      endpointHostHash: safeHostHash(provider.baseUrl),
      modelId: provider.modelId,
      fixtureSha256: sha256(corpus.longParagraph!),
      qaCount: result.items.length,
      fallback: result.fallback,
      promptVersion: result.promptVersion,
      providerCalls: transport.calls,
      usageFacts: harness.usage.facts.length,
      usage: result.usage,
      actualFacts: harness.usage.facts.filter((fact) => fact.intent !== true),
    });
  }, 180_000);

  it('L1-B11-A2-PARSE-004-F01R uses one repair call and never treats raw fallback as QA success', async () => {
    const provider = env();
    const transport = new CountingTransport();
    const adapter = new S5AiproxyHttpAdapter({
      baseUrl: provider.baseUrl,
      token: provider.token,
      transport,
    });
    const model: QaModelPort = {
      async generate(_input: QaModelInput) {
        const response = await adapter.invoke<{
          choices: Array<{ message: { content: string } }>;
        }>(
          {
            kind: 'llm',
            modelId: provider.modelId,
            messages: [
              {
                role: 'user',
                content: 'Return exactly the token INVALID_QA and no question-answer pairs.',
              },
            ],
            maxOutputTokens: 128,
          },
          context,
        );
        return {
          content: response.data.choices[0]?.message.content ?? '',
          usage: response.usage,
        };
      },
    };
    try {
      const result = await generateQa(
        {
          workspaceId: context.workspaceId,
          knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f10001',
          sourceId: '65f1e5b2a1c9d4b7e8f10002',
          chunkText: corpus.longParagraph!,
          sourceChunkHash: `sha256:${sha256(corpus.longParagraph!)}`,
          qaTemplateId: 'qa.default',
          qaTemplateVersion: 1,
          models: { llmModel: provider.modelId },
          limits: { maxQaPerChunk: 5, maxChunkCount: 50_000 },
        },
        {
          templateRegistry: createDefaultTemplateRegistry(),
          model,
          retryOnInvalidSchema: true,
          fallbackToChunkSplit: () => ({
            items: [
              {
                q: corpus.longParagraph!,
                a: '',
                sourceChunkHash: `sha256:${sha256(corpus.longParagraph!)}`,
              },
            ],
          }),
        },
      );
      expect(transport.calls).toBe(2);
      expect(result.fallback).toBe('chunk_split');
      expect(result.items).toEqual([expect.objectContaining({ q: corpus.longParagraph!, a: '' })]);
      writeProviderEvidence('b11-a2-real-qa-invalid-output.json', {
        status: 'REAL_VERIFIED',
        endpointHostHash: safeHostHash(provider.baseUrl),
        modelId: provider.modelId,
        providerCalls: transport.calls,
        repairAttempts: 1,
        fallback: result.fallback,
        qaCount: result.items.length,
        usage: result.usage,
      });
    } catch (error) {
      writeProviderEvidence('b11-a2-real-qa-invalid-output.json', {
        status: transport.calls === 2 ? 'FAIL' : 'FAIL_PROVIDER_CALL_COUNT',
        endpointHostHash: safeHostHash(provider.baseUrl),
        modelId: provider.modelId,
        providerCalls: transport.calls,
        expectedProviderCalls: 2,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
  }, 180_000);

  it('L1-B11-A2-PARSE-004-P04R sends the custom QA instruction and records its actual prompt version', async () => {
    const provider = env();
    const marker = 'B11_A2_REAL_CUSTOM_PROMPT_MARKER';
    const transport = new CountingTransport();
    const harness = pipeline({ modelId: provider.modelId, transport });
    try {
      const result = await harness.qa.generate({
        chunk: {
          index: 0,
          text: corpus.longParagraph!,
          contentHash: `sha256:${sha256(corpus.longParagraph!)}`,
        },
        settings: {
          trainingType: 'qa',
          chunkSettingMode: 'auto',
          qaPrompt: `${marker} Return one grounded QA pair in Q1/A1 format.`,
        },
        context,
        workspaceId: context.workspaceId,
        knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f10001',
        sourceId: '65f1e5b2a1c9d4b7e8f10002',
      });
      const requestBody = JSON.stringify(transport.requests[0]?.body ?? '');
      expect(requestBody).toContain(marker);
      expect(result.promptVersion).toMatch(/^sha256:[a-f0-9]{64}$/);
      writeProviderEvidence('b11-a2-real-qa-custom-prompt.json', {
        status: 'REAL_VERIFIED',
        endpointHostHash: safeHostHash(provider.baseUrl),
        modelId: provider.modelId,
        promptMarkerPresent: true,
        promptVersion: result.promptVersion,
        providerCalls: transport.calls,
        qaCount: result.items.length,
        usage: result.usage,
      });
    } catch (error) {
      const requestBody = JSON.stringify(transport.requests[0]?.body ?? '');
      writeProviderEvidence('b11-a2-real-qa-custom-prompt.json', {
        status: 'FAIL',
        endpointHostHash: safeHostHash(provider.baseUrl),
        modelId: provider.modelId,
        promptMarkerPresent: requestBody.includes(marker),
        providerCalls: transport.calls,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }
  }, 180_000);

  it('L1-B11-A2-PARSE-004-N01R classifies a real 401 without retry', async () => {
    const provider = env();
    const harness = pipeline({
      token: 'b11-a2-invalid-token',
      modelId: provider.modelId,
    });
    await expect(
      harness.qa.generate({
        chunk: {
          index: 0,
          text: corpus.validQa!,
          contentHash: `sha256:${sha256(corpus.validQa!)}`,
        },
        settings: { trainingType: 'qa', chunkSettingMode: 'auto' },
        context,
        workspaceId: context.workspaceId,
        knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f10001',
        sourceId: '65f1e5b2a1c9d4b7e8f10002',
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_MODEL_FAILED', retryable: false } },
    });
    expect(harness.transport.calls).toBe(1);
    writeProviderEvidence('b11-a2-real-qa-401.json', {
      status: 'REAL_VERIFIED',
      endpointHostHash: safeHostHash(provider.baseUrl),
      modelId: provider.modelId,
      providerCalls: harness.transport.calls,
      classification: 'KNOWLEDGE_MODEL_FAILED',
      retryable: false,
    });
  }, 180_000);
});
