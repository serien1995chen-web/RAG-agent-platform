import {
  createDefaultTemplateRegistry,
  dedupeQaItems,
  generateQa,
  MAX_QA_PER_CHUNK,
  type QaModelPort,
  type QaResultItem,
} from '@kb/qa';
import type { ChunkingSettings } from '@kb/chunk';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { createKnowledgeError } from '@kb/contracts';
import type { S5ModelGatewayPort, S5ModelInvocation } from './s5-model-gateway.port';
import type { S5QaChunkResult, S5QaPipelinePort } from './s5-processing.application';

interface ChatCompletionEnvelope {
  choices: Array<{ message: { content: string } }>;
}

function contentOf(data: unknown): string {
  if (typeof data !== 'object' || data === null) return '';
  const choices = (data as Partial<ChatCompletionEnvelope>).choices;
  return typeof choices?.[0]?.message?.content === 'string' ? choices[0].message.content : '';
}

export interface S5QaPipelineInput {
  chunk: {
    index: number;
    text: string;
    contentHash: string;
  };
  settings: ChunkingSettings;
  context: TenantContext;
  workspaceId: string;
  knowledgeSpaceId: string;
  sourceId: string;
  sourceVersion?: number;
}

export class S5QaPipelineAdapter implements S5QaPipelinePort {
  private readonly templates = createDefaultTemplateRegistry();

  constructor(
    private readonly input: {
      gateway: S5ModelGatewayPort;
      llmModelId?: string;
      embeddingModelId?: string;
      qaSchemaRetries?: number;
      resolveModels?: (input: {
        workspaceId: string;
        knowledgeSpaceId: string;
        context: TenantContext;
      }) => Promise<{ llmModelId: string; embeddingModelId?: string }>;
      assertRequestScope?: (input: {
        workspaceId: string;
        knowledgeSpaceId: string;
        sourceId: string;
        sourceVersion?: number;
        context: TenantContext;
      }) => Promise<void>;
    },
  ) {}

  async generate(request: S5QaPipelineInput): Promise<S5QaChunkResult> {
    if (request.workspaceId !== request.context.workspaceId) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_FORBIDDEN',
        requestId: request.context.requestId,
        traceId: request.context.traceId,
        details: { field: 'workspaceId' },
      });
    }
    if (this.input.assertRequestScope) {
      await this.input.assertRequestScope({
        workspaceId: request.workspaceId,
        knowledgeSpaceId: request.knowledgeSpaceId,
        sourceId: request.sourceId,
        ...(request.sourceVersion !== undefined ? { sourceVersion: request.sourceVersion } : {}),
        context: request.context,
      });
    }
    const selected = this.input.resolveModels
      ? await this.input.resolveModels({
          workspaceId: request.workspaceId,
          knowledgeSpaceId: request.knowledgeSpaceId,
          context: request.context,
        })
      : {
          llmModelId: this.input.llmModelId ?? '',
          embeddingModelId: this.input.embeddingModelId,
        };
    if (!selected.llmModelId) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: request.context.requestId,
        traceId: request.context.traceId,
        details: { field: 'modelBindings.llm', reason: 'required_for_qa' },
      });
    }
    let actualAttempts = 0;
    const model: QaModelPort = {
      generate: async (modelInput) => {
        const invocation: S5ModelInvocation = {
          kind: 'llm',
          modelId: selected.llmModelId,
          messages: [{ role: 'user', content: modelInput.prompt }],
          maxOutputTokens: 4_096,
        };
        const result = await this.input.gateway.invoke<ChatCompletionEnvelope>({
          ...invocation,
          workspaceId: request.workspaceId,
          knowledgeSpaceId: request.knowledgeSpaceId,
          requestId: request.context.requestId,
          traceId: request.context.traceId,
          context: request.context,
          resourceType: 'space',
          resourceId: request.knowledgeSpaceId,
          operation: `qa:${request.chunk.contentHash}`,
        });
        actualAttempts += result.attempts;
        return {
          content: contentOf(result.data),
          usage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          },
        };
      },
    };
    const result = await generateQa(
      {
        workspaceId: request.workspaceId,
        knowledgeSpaceId: request.knowledgeSpaceId,
        sourceId: request.sourceId,
        chunkText: request.chunk.text,
        sourceChunkHash: request.chunk.contentHash,
        qaTemplateId: 'qa.default',
        qaTemplateVersion: 1,
        ...(request.settings.qaPrompt ? { qaPrompt: request.settings.qaPrompt } : {}),
        models: {
          llmModel: selected.llmModelId,
          embeddingModel: selected.embeddingModelId ?? 'unused',
        },
        limits: { maxQaPerChunk: MAX_QA_PER_CHUNK, maxChunkCount: 50_000 },
      },
      {
        templateRegistry: this.templates,
        model,
        fallbackToChunkSplit: () => ({
          items: [
            {
              q: request.chunk.text,
              a: '',
              sourceChunkHash: request.chunk.contentHash,
            },
          ],
        }),
        retryOnInvalidSchema: (this.input.qaSchemaRetries ?? 1) > 0,
      },
    );
    return {
      items: result.items,
      fallback: result.fallback,
      promptVersion: result.promptVersion,
      usage: result.usage,
      attempts: actualAttempts,
      diagnostics: result.diagnostics.map((diagnostic) => ({
        severity: diagnostic.code === 'qa_output_invalid' ? 'warning' : 'info',
        code: diagnostic.code,
        ...(diagnostic.count === undefined ? {} : { count: diagnostic.count }),
      })),
    };
  }

  dedupe(items: readonly QaResultItem[]): QaResultItem[] {
    return dedupeQaItems(items, MAX_QA_PER_CHUNK).items;
  }
}
