import {
  createDefaultTemplateRegistry,
  dedupeQaItems,
  generateQa,
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
}

export class S5QaPipelineAdapter implements S5QaPipelinePort {
  private readonly templates = createDefaultTemplateRegistry();

  constructor(
    private readonly input: {
      gateway: S5ModelGatewayPort;
      llmModelId?: string;
      embeddingModelId?: string;
      resolveModels?: (input: {
        workspaceId: string;
        knowledgeSpaceId: string;
        context: TenantContext;
      }) => Promise<{ llmModelId: string; embeddingModelId?: string }>;
    },
  ) {}

  async generate(request: S5QaPipelineInput): Promise<S5QaChunkResult> {
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
        qaTemplateId: 'qa.default',
        qaTemplateVersion: 1,
        ...(request.settings.qaPrompt ? { qaPrompt: request.settings.qaPrompt } : {}),
        models: {
          llmModel: selected.llmModelId,
          embeddingModel: selected.embeddingModelId ?? 'unused',
        },
        limits: { maxQaPerChunk: 5, maxChunkCount: 50_000 },
      },
      {
        templateRegistry: this.templates,
        model,
        fallbackToChunkSplit: () => ({ items: [] }),
      },
    );
    return {
      items: result.items,
      fallback: result.fallback,
      promptVersion: 'qa.default@1',
      usage: result.usage,
    };
  }

  dedupe(items: readonly QaResultItem[]): QaResultItem[] {
    return dedupeQaItems(items, 5).items;
  }
}
