import { createKnowledgeError } from '@kb/contracts';
import type { ChunkingSettings } from '@kb/chunk';
import { z } from 'zod';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { S5ParseAsset, S5ParseDiagnostic } from './s5-processing-ports';
import type { S5ModelGatewayPort } from './s5-model-gateway.port';
import type { S8CaptionExecutorPort, S8ImageModelResolverPort } from './s8-image-deep.ports';
import { isS8ImageMimeType } from './s8-image-policy';

export const S8_PARAGRAPH_PROMPT_VERSION = 's8.paragraph-enhance.v1';

const EnhancementOutputSchema = z
  .object({
    markdown: z
      .string()
      .refine((value) => value.trim().length > 0, 'markdown must not be blank')
      .refine((value) => [...value].length <= 200_000, 'markdown is too large'),
  })
  .strict();

interface ChatCompletionEnvelope {
  choices: Array<{ message: { content: string } }>;
}

export interface S8ParagraphEnhancementResult {
  markdown: string;
  applied: boolean;
  promptVersion: typeof S8_PARAGRAPH_PROMPT_VERSION;
  usage: { inputTokens: number; outputTokens: number };
  diagnostics: S5ParseDiagnostic[];
}

export interface S8ContentEnhancementDependencies {
  gateway: S5ModelGatewayPort;
  models: S8ImageModelResolverPort;
  caption?: S8CaptionExecutorPort;
}

function headingCount(markdown: string): number {
  return markdown.split(/\r?\n/).filter((line) => /^#{1,6}\s+\S/.test(line.trim())).length;
}

function invalidOutput(context: TenantContext, reason: string) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_MODEL_OUTPUT_INVALID',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { reason },
  });
}

export class S8ContentEnhancementApplication {
  constructor(private readonly input: S8ContentEnhancementDependencies) {}

  async enhanceParagraph(input: {
    workspaceId: string;
    knowledgeSpaceId: string;
    sourceId: string;
    sourceVersion: number;
    rawText: string;
    settings: ChunkingSettings;
    context: TenantContext;
  }): Promise<S8ParagraphEnhancementResult> {
    const mode = input.settings.paragraphChunkAIMode ?? 'forbid';
    if (
      mode === 'forbid' ||
      input.settings.chunkSplitMode !== 'paragraph' ||
      input.settings.trainingType !== 'chunk'
    ) {
      return {
        markdown: input.rawText,
        applied: false,
        promptVersion: S8_PARAGRAPH_PROMPT_VERSION,
        usage: { inputTokens: 0, outputTokens: 0 },
        diagnostics: [],
      };
    }
    if (mode === 'auto' && headingCount(input.rawText) >= 2) {
      return {
        markdown: input.rawText,
        applied: false,
        promptVersion: S8_PARAGRAPH_PROMPT_VERSION,
        usage: { inputTokens: 0, outputTokens: 0 },
        diagnostics: [{ severity: 'info', code: 'paragraph_structure_detected' }],
      };
    }
    const model = await this.input.models.resolveLlm(input.knowledgeSpaceId, input.context);
    const result = await this.input.gateway.invoke<ChatCompletionEnvelope>({
      kind: 'llm',
      modelId: model.modelId,
      messages: [
        {
          role: 'system',
          content:
            'Structure the supplied knowledge text as Markdown. Preserve facts. Return only JSON: {"markdown":"..."}',
        },
        { role: 'user', content: [...input.rawText].slice(0, 48_000).join('') },
      ],
      maxOutputTokens: 4_096,
      workspaceId: input.workspaceId,
      knowledgeSpaceId: input.knowledgeSpaceId,
      resourceType: 'source',
      resourceId: input.sourceId,
      operation: `s8.paragraph-enhance:${input.sourceVersion}`,
      requestId: input.context.requestId,
      traceId: input.context.traceId,
      context: input.context,
    });
    const content = result.data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw invalidOutput(input.context, 'paragraph_content_missing');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw invalidOutput(input.context, 'paragraph_json_invalid');
    }
    const validated = EnhancementOutputSchema.safeParse(parsed);
    if (!validated.success) {
      throw invalidOutput(input.context, 'paragraph_schema_invalid');
    }
    return {
      markdown: validated.data.markdown,
      applied: true,
      promptVersion: S8_PARAGRAPH_PROMPT_VERSION,
      usage: result.usage,
      diagnostics: [{ severity: 'info', code: 'paragraph_ai_enhanced' }],
    };
  }

  async indexAssets(input: {
    sourceId: string;
    sourceVersion: number;
    assets: readonly S5ParseAsset[];
    orderOffset: number;
    context: TenantContext;
  }): Promise<{
    segmentIds: string[];
    diagnostics: S5ParseDiagnostic[];
    partial: boolean;
  }> {
    if (!this.input.caption) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: input.context.requestId,
        traceId: input.context.traceId,
        details: { field: 'imageIndex', reason: 'caption_application_missing' },
      });
    }
    const segmentIds: string[] = [];
    const diagnostics: S5ParseDiagnostic[] = [];
    for (const [index, asset] of input.assets.entries()) {
      if (!asset.objectRefId || !isS8ImageMimeType(asset.mimeType)) {
        diagnostics.push({
          severity: 'warning',
          code: 'image_asset_unsupported',
          path: asset.assetId,
        });
        continue;
      }
      try {
        const result = await this.input.caption.processAsset(
          {
            sourceId: input.sourceId,
            sourceVersion: input.sourceVersion,
            imageBlobRefId: asset.objectRefId,
            order: input.orderOffset + index,
            metadata: {
              imageAssetId: asset.assetId,
              imageAssetSha256: asset.sha256,
              imageAssetSizeBytes: asset.sizeBytes,
            },
          },
          input.context,
        );
        segmentIds.push(result.segmentId);
        if (result.partial) {
          diagnostics.push({
            severity: 'warning',
            code: 'image_asset_partial',
            path: asset.assetId,
          });
        }
      } catch {
        diagnostics.push({
          severity: 'warning',
          code: 'image_asset_index_failed',
          path: asset.assetId,
        });
      }
    }
    return {
      segmentIds,
      diagnostics,
      partial: diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'image_asset_partial' ||
          diagnostic.code === 'image_asset_index_failed',
      ),
    };
  }
}
