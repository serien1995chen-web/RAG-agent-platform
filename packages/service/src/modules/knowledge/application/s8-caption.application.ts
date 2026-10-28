import { createHash } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import { z } from 'zod';
import { tenantError, type TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type {
  S6JobRecord,
  S6SegmentRecord,
  S6SourceRecord,
  S6VectorPort,
} from './s06-processing-ports';
import type { S8CaptionDependencies, S8CaptionExecutorPort } from './s8-image-deep.ports';
import type { S5EmbeddingInputItem } from './s5-model-gateway.port';

export const S8_CAPTION_PROMPT_VERSION = 's8.image-caption.v1';
export const ImageCaptionOutputSchema = z
  .object({
    caption: z
      .string()
      .refine((value) => value.trim().length > 0, 'caption must not be blank')
      .refine((value) => [...value].length <= 8_000, 'caption must be <= 8000 code points'),
  })
  .strict();

interface ChatCompletionEnvelope {
  choices: Array<{ message: { content: string } }>;
}

interface EmbeddingEnvelope {
  data: Array<{ index?: number; embedding: number[] }>;
}

function outputInvalid(context: TenantContext, reason: string) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_MODEL_OUTPUT_INVALID',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { reason },
  });
}

function contentOf(data: unknown, context: TenantContext): string {
  if (typeof data !== 'object' || data === null) {
    throw outputInvalid(context, 'caption_envelope_invalid');
  }
  const choices = (data as Partial<ChatCompletionEnvelope>).choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw outputInvalid(context, 'caption_content_missing');
  }
  return content;
}

function captionOf(data: unknown, context: TenantContext): string {
  const content = contentOf(data, context);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw outputInvalid(context, 'caption_json_invalid');
  }
  const result = ImageCaptionOutputSchema.safeParse(parsed);
  if (!result.success) throw outputInvalid(context, 'caption_schema_invalid');
  return result.data.caption.trim();
}

function errorCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'problem' in error &&
    typeof (error as { problem?: { error?: { code?: unknown } } }).problem?.error?.code === 'string'
    ? String((error as { problem: { error: { code: string } } }).problem.error.code)
    : 'KNOWLEDGE_MODEL_FAILED';
}

function partialFailure(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === 'KNOWLEDGE_MODEL_FAILED' ||
    code === 'KNOWLEDGE_RATE_LIMITED' ||
    code === 'KNOWLEDGE_DEPENDENCY_TIMEOUT' ||
    code === 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE'
  );
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function s8CaptionKey(input: {
  sourceId: string;
  segmentId: string;
  imageBlobRefId: string;
  vlmModelId: string;
  promptVersion: string;
}): string {
  return hash(
    [
      input.sourceId,
      input.segmentId,
      input.imageBlobRefId,
      input.vlmModelId,
      input.promptVersion,
    ].join(':'),
  );
}

function imageInput(url: string): S5EmbeddingInputItem {
  return { type: 'image_url', image_url: { url } };
}

export class S8CaptionApplication implements S8CaptionExecutorPort {
  constructor(private readonly input: S8CaptionDependencies) {}

  private async caption(
    input: {
      sourceId: string;
      sourceVersion: number;
      knowledgeSpaceId: string;
      modelId: string;
      imageUrl: string;
      imageBytes: number;
    },
    context: TenantContext,
  ): Promise<{ caption: string; usage: { inputTokens: number; outputTokens: number } }> {
    const result = await this.input.gateway.invoke<ChatCompletionEnvelope>({
      kind: 'vlm',
      modelId: input.modelId,
      messages: [
        {
          role: 'user',
          content:
            'Describe this knowledge image for retrieval. Return only JSON: {"caption":"..."}',
        },
      ],
      imageUrls: [input.imageUrl],
      maxOutputTokens: 1_200,
      workspaceId: context.workspaceId,
      knowledgeSpaceId: input.knowledgeSpaceId,
      resourceType: 'source',
      resourceId: input.sourceId,
      operation: `s8.caption:${input.sourceVersion}`,
      audit: {
        promptVersion: S8_CAPTION_PROMPT_VERSION,
        mediaItemCount: 1,
        totalBytes: input.imageBytes,
        sourceVersion: input.sourceVersion,
      },
      requestId: context.requestId,
      traceId: context.traceId,
      context,
    });
    return {
      caption: captionOf(result.data, context),
      usage: result.usage,
    };
  }

  private async embed(
    input: {
      sourceId: string;
      knowledgeSpaceId: string;
      sourceVersion: number;
      modelId: string;
      dimension: 768 | 1024 | 1536 | 3072;
      caption: string | null;
      imageUrl: string;
      imageBytes: number;
    },
    context: TenantContext,
  ): Promise<{
    vectors: number[][];
    input: S5EmbeddingInputItem[];
    usage: { inputTokens: number; outputTokens: number };
  }> {
    const ordered: S5EmbeddingInputItem[] = [
      ...(input.caption ? ([{ type: 'text', text: input.caption }] as const) : []),
      imageInput(input.imageUrl),
    ];
    const result = await this.input.gateway.invoke<EmbeddingEnvelope>({
      kind: 'embedding',
      modelId: input.modelId,
      input: ordered,
      dimension: input.dimension,
      workspaceId: context.workspaceId,
      knowledgeSpaceId: input.knowledgeSpaceId,
      resourceType: 'source',
      resourceId: input.sourceId,
      operation: `s8.vision-embedding:${input.sourceVersion}`,
      audit: {
        promptVersion: S8_CAPTION_PROMPT_VERSION,
        mediaItemCount: 1,
        totalBytes: input.imageBytes,
        sourceVersion: input.sourceVersion,
      },
      requestId: context.requestId,
      traceId: context.traceId,
      context,
    });
    if (!Array.isArray(result.data?.data) || result.data.data.length !== ordered.length) {
      throw outputInvalid(context, 'vision_embedding_count_mismatch');
    }
    const vectors = [...result.data.data]
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map((item) => item.embedding);
    if (
      vectors.some(
        (vector) =>
          !Array.isArray(vector) ||
          vector.length !== input.dimension ||
          vector.some((value) => !Number.isFinite(value)),
      )
    ) {
      throw outputInvalid(context, 'vision_embedding_dimension_mismatch');
    }
    return { vectors, input: ordered, usage: result.usage };
  }

  private async indexImage(
    input: {
      source: S6SourceRecord;
      sourceVersion: number;
      imageBlobRefId: string;
      order: number;
      metadata: Record<string, unknown>;
      updateSourceStatus?: boolean;
    },
    context: TenantContext,
  ): Promise<{ partial: boolean; result: Record<string, unknown>; segmentId: string }> {
    const { source, sourceVersion, imageBlobRefId } = input;
    const sourceId = source.id;
    const object = imageBlobRefId
      ? await this.input.objects.findObjectRef(imageBlobRefId, context)
      : null;
    if (
      !object ||
      object.state !== 'active' ||
      object.purpose !== 'image' ||
      object.sourceId !== sourceId
    ) {
      throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', {
        imageBlobRefId,
        reason: 'active_bound_image_required',
      });
    }
    const [vlmResult, embeddingResult] = await Promise.allSettled([
      this.input.models.resolveVlm(source.knowledgeSpaceId, context),
      this.input.models.resolveVisionEmbedding(source.knowledgeSpaceId, context),
    ]);
    if (vlmResult.status === 'rejected' && embeddingResult.status === 'rejected') {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: {
          reason: 'vision_models_unavailable',
          fields: ['modelBindings.vlm', 'modelBindings.visionEmbedding'],
        },
      });
    }
    const vlm = vlmResult.status === 'fulfilled' ? vlmResult.value : null;
    const visionEmbedding = embeddingResult.status === 'fulfilled' ? embeddingResult.value : null;
    const vlmResolutionFailure = vlmResult.status === 'rejected' ? vlmResult.reason : undefined;
    const embeddingResolutionFailure =
      embeddingResult.status === 'rejected' ? embeddingResult.reason : undefined;
    const segment = await this.input.indexes.ensureImageSegment(
      {
        source,
        imageBlobRefId,
        order: input.order,
        metadata: input.metadata,
      },
      context,
    );
    const ticket = this.input.tickets.issueImage({
      workspaceId: context.workspaceId,
      blobId: imageBlobRefId,
      sourceId,
      knowledgeSpaceId: source.knowledgeSpaceId,
      ttlSeconds: 300,
      context,
    });
    const captionKey = s8CaptionKey({
      sourceId,
      segmentId: segment.id,
      imageBlobRefId,
      vlmModelId: vlm?.modelId ?? 'unavailable',
      promptVersion: S8_CAPTION_PROMPT_VERSION,
    });
    let caption: string | null = null;
    let captionFailure: unknown = vlmResolutionFailure;
    let captionUsage = { inputTokens: 0, outputTokens: 0 };
    if (vlm) {
      try {
        const generated = await this.caption(
          {
            sourceId,
            sourceVersion,
            knowledgeSpaceId: source.knowledgeSpaceId,
            modelId: vlm.modelId,
            imageUrl: ticket.url,
            imageBytes: object.sizeBytes,
          },
          context,
        );
        caption = generated.caption;
        captionUsage = generated.usage;
      } catch (error) {
        if (!partialFailure(error)) throw error;
        captionFailure = error;
      }
    }

    let vectors: number[][] = [];
    let embeddingInput: S5EmbeddingInputItem[] = [];
    let embeddingFailure: unknown = embeddingResolutionFailure;
    let embeddingUsage = { inputTokens: 0, outputTokens: 0 };
    if (visionEmbedding) {
      try {
        const generated = await this.embed(
          {
            sourceId,
            knowledgeSpaceId: source.knowledgeSpaceId,
            sourceVersion,
            modelId: visionEmbedding.modelId,
            dimension: visionEmbedding.dimension,
            caption,
            imageUrl: ticket.url,
            imageBytes: object.sizeBytes,
          },
          context,
        );
        vectors = generated.vectors;
        embeddingInput = generated.input;
        embeddingUsage = generated.usage;
      } catch (error) {
        if (!partialFailure(error)) throw error;
        embeddingFailure = error;
      }
    }

    const captionIndexed = caption !== null;
    const vectorIndexed = vectors.length === embeddingInput.length && vectors.length > 0;
    if (!captionIndexed && !vectorIndexed) {
      throw embeddingFailure ?? captionFailure ?? outputInvalid(context, 'image_index_failed');
    }
    let projectedVersion = segment.version;
    if (caption !== null) {
      const indexedCaption = caption;
      projectedVersion = (
        await this.input.fulltext.project(
          {
            segmentId: segment.id,
            sourceVersion,
            indexVersion: segment.version + 1,
            question: indexedCaption,
            answer: '',
            content: indexedCaption,
            searchEnabled: source.searchEnabled,
            expectedVersion: segment.version,
          },
          context,
        )
      ).segmentVersion;
    }

    const indexes: S6SegmentRecord['indexes'] = [];
    if (vectorIndexed) {
      const indexVersion = segment.version + 2;
      const textOffset = embeddingInput[0]?.type === 'text' ? 1 : 0;
      const captionVector = textOffset === 1 ? vectors[0] : undefined;
      const imageVector = vectors[textOffset] ?? vectors[0];
      if (!imageVector) throw outputInvalid(context, 'image_vector_missing');
      const profile = this.input.vectors
        .listProfiles()
        .find((item) => item.dimension === visionEmbedding?.dimension);
      if (!profile) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_INTERNAL_ERROR',
          requestId: context.requestId,
          traceId: context.traceId,
          details: {
            reason: 'vector_profile_missing',
            dimension: visionEmbedding?.dimension ?? 0,
          },
        });
      }
      const records: Array<Parameters<S6VectorPort['insert']>[0][number]> = [];
      if (captionVector) {
        records.push({
          workspaceId: context.workspaceId,
          knowledgeSpaceId: source.knowledgeSpaceId,
          sourceId,
          segmentId: segment.id,
          indexId: 'image_caption',
          embeddingModelId: visionEmbedding!.modelId,
          dimension: visionEmbedding!.dimension,
          vector: captionVector,
          searchEnabled: source.searchEnabled,
          contentHash: hash(caption ?? ''),
          version: indexVersion,
        });
      }
      records.push({
        workspaceId: context.workspaceId,
        knowledgeSpaceId: source.knowledgeSpaceId,
        sourceId,
        segmentId: segment.id,
        indexId: 'image',
        embeddingModelId: visionEmbedding!.modelId,
        dimension: visionEmbedding!.dimension,
        vector: imageVector,
        searchEnabled: source.searchEnabled,
        contentHash: hash(`${caption ?? ''}\n${imageBlobRefId}`),
        version: indexVersion,
      });
      const written = await this.input.vectors.insert(records, context);
      if (written.vectorIds.length !== records.length) {
        throw outputInvalid(context, 'image_vector_insert_count_mismatch');
      }
      let vectorIndex = 0;
      if (captionVector) {
        indexes.push({
          indexId: 'image_caption',
          type: 'image_caption',
          modelId: visionEmbedding!.modelId,
          dimension: visionEmbedding!.dimension,
          storageType: profile.storageType,
          vectorProfile: profile.tableName,
          vectorId: written.vectorIds[vectorIndex++]!,
          text: caption ?? '',
          version: indexVersion,
        });
      }
      indexes.push({
        indexId: 'image',
        type: 'image',
        modelId: visionEmbedding!.modelId,
        dimension: visionEmbedding!.dimension,
        storageType: profile.storageType,
        vectorProfile: profile.tableName,
        vectorId: written.vectorIds[vectorIndex]!,
        text: caption ?? '',
        version: indexVersion,
      });
    }

    const committed = await this.input.indexes.commit(
      {
        segmentId: segment.id,
        expectedVersion: projectedVersion,
        sourceVersion,
        imageBlobRefId,
        imageDescription: caption ?? '',
        captionStatus: captionIndexed ? 'indexed' : 'error',
        vectorStatus: vectorIndexed ? 'indexed' : 'error',
        captionPromptVersion: S8_CAPTION_PROMPT_VERSION,
        visionEmbeddingModelId: visionEmbedding?.modelId ?? 'unavailable',
        captionKey,
        indexes,
      },
      context,
    );
    if (!committed) {
      throw tenantError(context, 'KNOWLEDGE_CONFLICT', {
        segmentId: segment.id,
        expectedVersion: projectedVersion,
      });
    }
    if (input.updateSourceStatus !== false) {
      await this.input.store.updateSourceStatus(
        sourceId,
        captionIndexed && vectorIndexed ? 'ready' : 'partial',
        context,
        sourceVersion,
      );
    }

    return {
      partial: captionIndexed !== vectorIndexed,
      segmentId: segment.id,
      result: {
        captionStatus: captionIndexed ? 'indexed' : 'error',
        vectorStatus: vectorIndexed ? 'indexed' : 'error',
        captionPromptVersion: S8_CAPTION_PROMPT_VERSION,
        visionEmbeddingModelId: visionEmbedding?.modelId ?? 'unavailable',
        captionKey,
        sourceVersion,
        usage: {
          inputTokens: captionUsage.inputTokens + embeddingUsage.inputTokens,
          outputTokens: captionUsage.outputTokens + embeddingUsage.outputTokens,
        },
        ...(captionFailure ? { captionFailureCode: errorCode(captionFailure) } : {}),
        ...(embeddingFailure ? { embeddingFailureCode: errorCode(embeddingFailure) } : {}),
      },
    };
  }

  private async sourceForJob(
    job: S6JobRecord,
    context: TenantContext,
  ): Promise<{
    source: S6SourceRecord;
    sourceVersion: number;
    imageBlobRefId: string;
  }> {
    const sourceId = String(job.inputSnapshot.sourceId ?? job.resourceId);
    const source = await this.input.store.getSource(sourceId, context);
    if (!source || source.kind !== 'image') {
      throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { sourceId, kind: 'image_required' });
    }
    const sourceVersion = Number(job.inputSnapshot.sourceVersion ?? source.sourceVersion);
    if (sourceVersion !== source.sourceVersion) {
      throw tenantError(context, 'KNOWLEDGE_CONFLICT', {
        sourceId,
        expectedVersion: sourceVersion,
        actualVersion: source.sourceVersion,
      });
    }
    return {
      source,
      sourceVersion,
      imageBlobRefId: String(job.inputSnapshot.imageBlobRefId ?? source.blobRefId ?? ''),
    };
  }

  async execute(
    job: S6JobRecord,
    context: TenantContext,
  ): Promise<{ result: Record<string, unknown>; value: string }> {
    const input = await this.sourceForJob(job, context);
    const result = await this.indexImage(
      {
        ...input,
        order: 0,
        metadata: { imageSource: true },
        updateSourceStatus: true,
      },
      context,
    );
    return { result: result.result, value: result.segmentId };
  }

  async processAsset(
    input: {
      sourceId: string;
      sourceVersion: number;
      imageBlobRefId: string;
      order: number;
      metadata: Record<string, unknown>;
    },
    context: TenantContext,
  ): Promise<{ segmentId: string; partial: boolean }> {
    const source = await this.input.store.getSource(input.sourceId, context);
    if (!source) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { sourceId: input.sourceId });
    if (input.sourceVersion !== source.sourceVersion) {
      throw tenantError(context, 'KNOWLEDGE_CONFLICT', {
        sourceId: input.sourceId,
        expectedVersion: input.sourceVersion,
        actualVersion: source.sourceVersion,
      });
    }
    const result = await this.indexImage(
      {
        source,
        sourceVersion: input.sourceVersion,
        imageBlobRefId: input.imageBlobRefId,
        order: input.order,
        metadata: input.metadata,
        updateSourceStatus: false,
      },
      context,
    );
    return { segmentId: result.segmentId, partial: result.partial };
  }

  async markFinalFailure(job: S6JobRecord, context: TenantContext): Promise<void> {
    const sourceId = String(job.inputSnapshot.sourceId ?? job.resourceId);
    const source = await this.input.store.getSource(sourceId, context);
    const imageBlobRefId = String(job.inputSnapshot.imageBlobRefId ?? source?.blobRefId ?? '');
    if (!source || !imageBlobRefId) return;
    await this.input.indexes.markFinalFailure(
      {
        sourceId,
        sourceVersion: Number(job.inputSnapshot.sourceVersion ?? source.sourceVersion),
        imageBlobRefId,
      },
      context,
    );
    await this.input.store.updateSourceStatus(sourceId, 'failed', context);
  }
}
