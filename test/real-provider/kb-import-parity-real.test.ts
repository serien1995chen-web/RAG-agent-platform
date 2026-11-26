import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QA_PROMPT,
  QA_FIXED_TEMPLATE,
  createDefaultTemplateRegistry,
  generateQa,
} from '../../packages/qa/src/index';
import {
  AxiosS5HttpTransport,
  S5AiproxyHttpAdapter,
  type S5HttpRequest,
} from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import type {
  S5GatewayUsageFact,
  S5UsageRecorderPort,
} from '../../packages/service/src/modules/knowledge/application/s5-model-gateway.port';
import { S5ModelGateway } from '../../packages/service/src/modules/knowledge/application/s5-model-gateway';
import type { ModelCatalogPort } from '../../packages/service/src/modules/knowledge/application/s5-model-ports';
import { S5QaPipelineAdapter } from '../../packages/service/src/modules/knowledge/application/s5-qa-pipeline';
import { S8ContentEnhancementApplication } from '../../packages/service/src/modules/knowledge/application/s8-content-enhancement.application';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';
import {
  requiredProviderEnv,
  safeHostHash,
  sha256,
  writeProviderEvidence,
} from './s11-real-helpers';

const context: TenantContext = {
  workspaceId: 'ws_kb_import_parity_real',
  memberId: 'mem_kb_import_parity_real',
  requestId: 'req-kb-import-parity-real',
  traceId: 'trace-kb-import-parity-real',
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
};

const sourceText =
  '退款申请需在购买后七天内提交。提交后客服会在两个工作日内审核，审核通过后原路退款。售后工单会保留处理记录。';

class Usage implements S5UsageRecorderPort {
  readonly facts: S5GatewayUsageFact[] = [];

  async recordInvocationUsage(fact: S5GatewayUsageFact) {
    this.facts.push(fact);
    return true;
  }
}

class CountingTransport extends AxiosS5HttpTransport {
  readonly requests: S5HttpRequest[] = [];

  override async request<T = unknown>(
    input: Parameters<AxiosS5HttpTransport['request']>[0],
  ): Promise<Awaited<ReturnType<AxiosS5HttpTransport['request']>>> {
    this.requests.push(input);
    return super.request<T>(input);
  }
}

function provider() {
  return {
    baseUrl: requiredProviderEnv('AIPROXY_BASE_URL'),
    token: requiredProviderEnv('AIPROXY_API_TOKEN'),
    modelId:
      process.env.S11_AIPROXY_LLM_MODEL?.trim() || requiredProviderEnv('B11_B_REAL_LLM_MODEL_ID'),
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

function harness() {
  const config = provider();
  const transport = new CountingTransport();
  const usage = new Usage();
  const gateway = new S5ModelGateway({
    catalog: catalogFor(config.modelId),
    adapter: new S5AiproxyHttpAdapter({
      baseUrl: config.baseUrl,
      token: config.token,
      transport,
    }),
    usage,
    sleep: async () => undefined,
  });
  return { config, transport, usage, gateway };
}

describe('FastGPT knowledge import parity with a real AIProxy model', () => {
  it('enhances QA paragraph structure through the configured real LLM', async () => {
    const runtime = harness();
    const application = new S8ContentEnhancementApplication({
      gateway: runtime.gateway,
      models: {
        async resolveLlm() {
          return {
            modelId: runtime.config.modelId,
            displayName: runtime.config.modelId,
            type: 'llm',
            capabilities: ['chat'],
            dimension: null,
            authorized: true,
          };
        },
        async resolveVlm() {
          throw new Error('not used');
        },
        async resolveVisionEmbedding() {
          throw new Error('not used');
        },
      },
    });
    const result = await application.enhanceParagraph({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f10001',
      sourceId: '65f1e5b2a1c9d4b7e8f10002',
      sourceVersion: 1,
      rawText: sourceText,
      settings: {
        trainingType: 'qa',
        chunkSettingMode: 'custom',
        chunkSplitMode: 'paragraph',
        paragraphChunkAIMode: 'force',
        chunkSize: 1_000,
      },
      context,
    });
    expect(result.applied).toBe(true);
    expect(result.markdown).not.toBe(sourceText);
    expect(runtime.transport.requests).toHaveLength(1);
    writeProviderEvidence('kb-import-paragraph-real.json', {
      status: 'REAL_VERIFIED',
      endpointHostHash: safeHostHash(runtime.config.baseUrl),
      modelId: runtime.config.modelId,
      sourceSha256: sha256(sourceText),
      applied: result.applied,
      providerCalls: runtime.transport.requests.length,
      usage: result.usage,
    });
  }, 180_000);

  it('sends the FastGPT QA guidance and 50-question contract to the real model', async () => {
    const runtime = harness();
    const qa = new S5QaPipelineAdapter({
      gateway: runtime.gateway,
      qaSchemaRetries: 0,
      resolveModels: async () => ({ llmModelId: runtime.config.modelId }),
    });
    const result = await qa.generate({
      chunk: {
        index: 0,
        text: sourceText,
        contentHash: `sha256:${sha256(sourceText)}`,
      },
      settings: {
        trainingType: 'qa',
        chunkSettingMode: 'custom',
        chunkSplitMode: 'paragraph',
        paragraphChunkAIMode: 'forbid',
        chunkSize: 1_000,
      },
      context,
      workspaceId: context.workspaceId,
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f10001',
      sourceId: '65f1e5b2a1c9d4b7e8f10002',
    });
    const requestContent =
      (
        runtime.transport.requests[0]?.body as
          | { messages?: Array<{ content?: string }> }
          | undefined
      )?.messages?.[0]?.content ?? '';
    expect(requestContent).toContain(DEFAULT_QA_PROMPT.trim());
    expect(requestContent).toContain(QA_FIXED_TEMPLATE.replaceAll('{{text}}', sourceText).trim());
    expect(requestContent).toContain('最多提出 50 个问题');
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.length).toBeLessThanOrEqual(50);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    writeProviderEvidence('kb-import-qa-real.json', {
      status: 'REAL_VERIFIED',
      endpointHostHash: safeHostHash(runtime.config.baseUrl),
      modelId: runtime.config.modelId,
      providerCalls: runtime.transport.requests.length,
      qaCount: result.items.length,
      promptHasFiftyQuestionContract: requestContent.includes('最多提出 50 个问题'),
      promptHasFixedContextEnvelope: requestContent.includes('<Context>'),
      promptVersion: result.promptVersion,
      usage: result.usage,
    });
  }, 180_000);

  it('generates a QA pair from the shared default template with real provider usage', async () => {
    const runtime = harness();
    let responseContent = '';
    const result = await generateQa(
      {
        workspaceId: context.workspaceId,
        knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f10001',
        sourceId: '65f1e5b2a1c9d4b7e8f10002',
        chunkText: sourceText,
        sourceChunkHash: `sha256:${sha256(sourceText)}`,
        qaTemplateId: 'qa.default',
        qaTemplateVersion: 1,
        models: { llmModel: runtime.config.modelId },
        limits: { maxQaPerChunk: 50, maxChunkCount: 50_000 },
      },
      {
        templateRegistry: createDefaultTemplateRegistry(),
        model: {
          async generate(input) {
            const response = await runtime.gateway.invoke<{
              choices: Array<{ message: { content: string } }>;
            }>({
              kind: 'llm',
              modelId: runtime.config.modelId,
              messages: [{ role: 'user', content: input.prompt }],
              maxOutputTokens: 4_096,
              workspaceId: context.workspaceId,
              knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f10001',
              resourceType: 'space',
              resourceId: '65f1e5b2a1c9d4b7e8f10001',
              operation: 'kb-import-qa-real',
              audit: {
                promptVersion: 'qa.default@1',
                mediaItemCount: 0,
                totalBytes: Buffer.byteLength(sourceText, 'utf8'),
                sourceVersion: 1,
              },
              requestId: context.requestId,
              traceId: context.traceId,
              context,
            });
            responseContent = response.data.choices[0]?.message.content ?? '';
            return {
              content: responseContent,
              usage: response.usage,
            };
          },
        },
        retryOnInvalidSchema: false,
      },
    );
    expect(
      result.items.length,
      JSON.stringify({
        responseContent,
        fallback: result.fallback,
        diagnostics: result.diagnostics,
      }),
    ).toBeGreaterThan(0);
    expect(result.fallback).toBe('none');
    expect(result.promptVersion).toBe('qa.default@1');
  }, 180_000);
});
