import { randomUUID } from 'node:crypto';
import {
  ImageSearchApiRequestSchema,
  SearchApiResponseSchema,
  createKnowledgeError,
  toPipelineSearchRequest,
  type CitationApi,
  type ImageSearchApiRequest,
  type SearchApiResponse,
} from '@kb/contracts';
import {
  finalizeSearchCandidates,
  fuseImageChannels,
  fuseTextAndImageBlocks,
  type AuthorizedCandidate,
  type Candidate,
} from '@kb/search';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { tenantError } from '../../../shared/persistence/knowledge/tenant';
import type { KnowledgeOperationInput, KnowledgeOperationResult } from './operation-types';
import type { S8CaptionStatus, S8ImageSearchDependencies } from './s8-image-deep.ports';
import { assertS8ImageMedia } from './s8-image-policy';

interface EmbeddingEnvelope {
  data: Array<{ index?: number; embedding: number[] }>;
}

function validationError(context: TenantContext, details: Record<string, unknown>) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_VALIDATION_FAILED',
    requestId: context.requestId,
    traceId: context.traceId,
    details,
  });
}

function problemCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'problem' in error &&
    typeof (error as { problem?: { error?: { code?: unknown } } }).problem?.error?.code === 'string'
    ? String((error as { problem: { error: { code: string } } }).problem.error.code)
    : 'KNOWLEDGE_INTERNAL_ERROR';
}

function recoverableImageRecallFailure(error: unknown): boolean {
  const code = problemCode(error);
  return (
    code === 'KNOWLEDGE_MODEL_FAILED' ||
    code === 'KNOWLEDGE_MODEL_OUTPUT_INVALID' ||
    code === 'KNOWLEDGE_RATE_LIMITED' ||
    code === 'KNOWLEDGE_DEPENDENCY_TIMEOUT' ||
    code === 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE'
  );
}

function failureRank(error: unknown): number {
  const code = problemCode(error);
  if (code === 'KNOWLEDGE_DEPENDENCY_TIMEOUT') return 0;
  if (code === 'KNOWLEDGE_RATE_LIMITED') return 1;
  if (code === 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE') return 2;
  if (
    code === 'KNOWLEDGE_MODEL_FAILED' ||
    code === 'KNOWLEDGE_MODEL_OUTPUT_INVALID' ||
    code === 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID'
  ) {
    return 3;
  }
  return 4;
}

function citationKey(spaceId: string, segmentId: string): string {
  return `${spaceId}:${segmentId}`;
}

function candidateWithImageIdentity(candidate: AuthorizedCandidate): Candidate {
  const imageBlobRefId = candidate.segment.imageBlobRefId;
  return {
    ...candidate,
    ...(imageBlobRefId ? { imageIdentity: `${candidate.segmentId}:${imageBlobRefId}` } : {}),
  };
}

export class S8ImageSearchApplication {
  constructor(
    private readonly input: S8ImageSearchDependencies & {
      now?: () => Date;
      searchIdFactory?: () => string;
    },
  ) {}

  private parse(body: unknown, context: TenantContext): ImageSearchApiRequest {
    const parsed = ImageSearchApiRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw validationError(context, {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      });
    }
    return parsed.data;
  }

  private async queryObjects(
    request: ImageSearchApiRequest,
    context: TenantContext,
  ): Promise<
    NonNullable<Awaited<ReturnType<S8ImageSearchDependencies['objects']['findObjectRef']>>>[]
  > {
    const objects = await Promise.all(
      request.imageUploadIds.map((uploadId) => this.input.objects.findObjectRef(uploadId, context)),
    );
    return objects.map((object, index) => {
      if (
        !object ||
        object.state !== 'active' ||
        object.workspaceId !== context.workspaceId ||
        object.knowledgeSpaceId !== request.knowledgeSpaceId ||
        object.purpose !== 'image' ||
        (object.expiresAt !== null && Date.parse(object.expiresAt) <= Date.now())
      ) {
        throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', {
          field: 'imageUploadIds',
          index,
          reason: 'active_unexpired_same_space_image_object_required',
        });
      }
      assertS8ImageMedia(
        {
          mimeType: object.mimeType,
          fileName: object.originalName,
          sizeBytes: object.sizeBytes,
        },
        context,
      );
      return object;
    });
  }

  private async queryVectors(
    request: ImageSearchApiRequest,
    context: TenantContext,
  ): Promise<{ vectors: number[][]; modelId: string; dimension: 768 | 1024 | 1536 | 3072 }> {
    const model = await this.input.models.resolveVisionEmbedding(request.knowledgeSpaceId, context);
    const objects = await this.queryObjects(request, context);
    const input = objects.map((object) => {
      const ticket = this.input.tickets.issueImage({
        workspaceId: context.workspaceId,
        blobId: object.blobId,
        sourceId: object.sourceId,
        knowledgeSpaceId: object.knowledgeSpaceId,
        ttlSeconds: 300,
        context,
      });
      return { type: 'image_url' as const, image_url: { url: ticket.url } };
    });
    const result = await this.input.gateway.invoke<EmbeddingEnvelope>({
      kind: 'embedding',
      modelId: model.modelId,
      input,
      dimension: model.dimension,
      workspaceId: context.workspaceId,
      knowledgeSpaceId: request.knowledgeSpaceId,
      resourceType: 'space',
      resourceId: request.knowledgeSpaceId,
      operation: 's8.image-query-embedding',
      requestId: context.requestId,
      traceId: context.traceId,
      context,
    });
    if (!Array.isArray(result.data?.data) || result.data.data.length !== input.length) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_MODEL_OUTPUT_INVALID',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'query_embedding_count_mismatch' },
      });
    }
    const vectors = [...result.data.data]
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map((item) => item.embedding);
    if (
      vectors.some(
        (vector) =>
          vector.length !== model.dimension || vector.some((value) => !Number.isFinite(value)),
      )
    ) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_MODEL_OUTPUT_INVALID',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'query_embedding_dimension_mismatch' },
      });
    }
    return { vectors, modelId: model.modelId, dimension: model.dimension };
  }

  private async recallImageDescendants(
    candidates: readonly Candidate[],
    request: ImageSearchApiRequest,
    context: TenantContext,
  ): Promise<AuthorizedCandidate[]> {
    const hydrated = await this.input.authorization.hydrate(candidates, {
      requestId: context.requestId,
      workspaceId: context.workspaceId,
      memberId: context.memberId,
      traceId: context.traceId,
      scopes: context.scopes,
      isWorkspaceOwner: context.isWorkspaceOwner,
      ...(context.apiKeyId ? { apiKeyId: context.apiKeyId } : {}),
    });
    return hydrated.items
      .filter((candidate) => candidate.knowledgeSpaceId === request.knowledgeSpaceId)
      .filter((candidate) => Boolean(candidate.segment.imageBlobRefId))
      .map((candidate) => candidateWithImageIdentity(candidate) as AuthorizedCandidate);
  }

  private async captionCandidates(
    request: ImageSearchApiRequest,
    context: TenantContext,
  ): Promise<{ candidates: AuthorizedCandidate[]; failed: boolean; error?: unknown }> {
    try {
      const hits = await this.input.fullText.search(
        {
          knowledgeSpaceId: request.knowledgeSpaceId,
          ...(request.filters?.sourceIds ? { sourceIds: request.filters.sourceIds } : {}),
          text: request.query,
          limit: 100,
          options: { timeoutMs: 5_000 },
        },
        { requestId: context.requestId, workspaceId: context.workspaceId },
      );
      const candidates = hits.map(
        (hit, index): Candidate => ({
          docId: `${request.knowledgeSpaceId}:${hit.segmentId}`,
          segmentId: hit.segmentId,
          sourceId: hit.sourceId,
          knowledgeSpaceId: request.knowledgeSpaceId,
          score: hit.score,
          fullTextScore: hit.score,
          ...(hit.fullTextVersion !== undefined ? { fullTextVersion: hit.fullTextVersion } : {}),
          scores: [{ type: 'fullText', value: hit.score, index }],
          text: '',
        }),
      );
      const hydrated = await this.recallImageDescendants(candidates, request, context);
      return {
        candidates: hydrated.filter(
          (candidate) =>
            (candidate.segment.metadata.captionStatus as S8CaptionStatus | undefined) ===
              'indexed' || Boolean(candidate.segment.imageDescription),
        ),
        failed: false,
      };
    } catch (error) {
      if (!recoverableImageRecallFailure(error)) throw error;
      return { candidates: [], failed: true, error };
    }
  }

  private async imageVectorCandidates(
    request: ImageSearchApiRequest,
    context: TenantContext,
  ): Promise<{ candidates: AuthorizedCandidate[]; failed: boolean; error?: unknown }> {
    try {
      const query = await this.queryVectors(request, context);
      const raw: Candidate[] = [];
      for (const [queryIndex, vector] of query.vectors.entries()) {
        const hits = await this.input.vectors.recall(
          {
            workspaceId: context.workspaceId,
            knowledgeSpaceId: request.knowledgeSpaceId,
            ...(request.filters?.sourceIds ? { sourceIds: request.filters.sourceIds } : {}),
            dimension: query.dimension,
            embeddingModelId: query.modelId,
            vector,
            limit: 100,
          },
          context,
        );
        hits.forEach((hit, index) => {
          raw.push({
            docId: `${hit.knowledgeSpaceId}:${hit.segmentId}:${hit.vectorId}`,
            segmentId: hit.segmentId,
            sourceId: hit.sourceId,
            knowledgeSpaceId: hit.knowledgeSpaceId,
            score: hit.score,
            embeddingScore: hit.score,
            indexId: hit.indexId,
            indexVersion: hit.version,
            scores: [{ type: 'embedding', value: hit.score, index: queryIndex * 100 + index }],
            text: '',
          });
        });
      }
      const hydrated = await this.recallImageDescendants(raw, request, context);
      return {
        candidates: hydrated.filter((candidate) =>
          candidate.segment.indexes.some((index) => index.type === 'image'),
        ),
        failed: false,
      };
    } catch (error) {
      if (!recoverableImageRecallFailure(error)) throw error;
      return { candidates: [], failed: true, error };
    }
  }

  private response(input: {
    searchId: string;
    request: ImageSearchApiRequest;
    candidates: readonly AuthorizedCandidate[];
    citations: ReadonlyMap<string, CitationApi>;
    partial: boolean;
    durationMs: number;
    degradedCodes: readonly string[];
    rerankApplied: boolean;
  }): SearchApiResponse {
    return SearchApiResponseSchema.parse({
      searchId: input.searchId,
      mode: 'image',
      items: input.candidates.map((candidate) => {
        const citation = input.citations.get(
          citationKey(candidate.knowledgeSpaceId, candidate.segmentId),
        );
        if (!citation) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_INTERNAL_ERROR',
            requestId: input.searchId,
            traceId: input.searchId,
            details: { reason: 'image_citation_missing' },
          });
        }
        return {
          segment: {
            id: candidate.segment.id,
            workspaceId: candidate.segment.workspaceId,
            knowledgeSpaceId: candidate.knowledgeSpaceId,
            sourceId: candidate.sourceId,
            searchEnabled: candidate.segment.searchEnabled,
            order: candidate.segment.order,
            question: candidate.segment.question,
            answer: candidate.segment.answer,
            content: candidate.segment.content,
            metadata: candidate.segment.metadata,
            indexes: candidate.segment.indexes.map((index) => ({
              indexId: index.indexId,
              type: index.type as
                | 'default'
                | 'custom'
                | 'question'
                | 'summary'
                | 'image'
                | 'image_caption',
              modelId: index.modelId,
              dimension: index.dimension,
              storageType: index.dimension === 3072 ? ('halfvec' as const) : ('vector' as const),
              vectorProfile: index.vectorProfile as
                | 'knowledge_segment_vectors_768'
                | 'knowledge_segment_vectors_1024'
                | 'knowledge_segment_vectors_1536'
                | 'knowledge_segment_vectors_3072',
              vectorId: index.vectorId,
              text: index.text,
              version: index.version,
            })),
            indexStatus: candidate.segment.indexStatus,
            indexErrorCode: candidate.segment.indexErrorCode,
            imageBlobRefId: candidate.segment.imageBlobRefId,
            version: candidate.segment.version,
          },
          score: candidate.embeddingScore ?? candidate.fullTextScore ?? candidate.score,
          citation,
        };
      }),
      partial: input.partial,
      durationMs: input.durationMs,
      degraded: [...new Set(input.degradedCodes)],
      rerankApplied: input.rerankApplied,
    });
  }

  async search(body: unknown, context: TenantContext): Promise<SearchApiResponse> {
    const request = this.parse(body, context);
    this.input.access.assertSearchScope(context);
    await this.input.access.getAuthorizedSpace(request.knowledgeSpaceId, context);
    const startedAt = Date.now();
    const searchId = this.input.searchIdFactory?.() ?? `search_${randomUUID()}`;
    const degraded: string[] = [];
    try {
      const [caption, imageVectors, text] = await Promise.all([
        this.captionCandidates(request, context),
        this.imageVectorCandidates(request, context),
        this.input.search
          .collectCandidates({
            request: {
              knowledgeSpaceId: request.knowledgeSpaceId,
              query: request.query,
              tokenBudget: request.tokenBudget,
              similarity: request.similarity,
              embeddingWeight: request.embeddingWeight,
              usingRerank: request.usingRerank,
              rerankWeight: request.rerankWeight,
              ...(request.filters ? { filters: request.filters } : {}),
            },
            knowledgeSpaceIds: [request.knowledgeSpaceId],
            mode: 'hybrid',
            context,
            limit: 20,
          })
          .catch((error: unknown) => ({
            candidates: [],
            partial: true,
            degradedCodes: ['text_recall_failed'],
            rerankApplied: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            error,
          })),
      ]);
      if (caption.failed) degraded.push('image_caption_recall_failed');
      if (imageVectors.failed) degraded.push('image_vector_recall_failed');
      degraded.push(...text.degradedCodes);
      if (
        caption.candidates.length === 0 &&
        imageVectors.candidates.length === 0 &&
        text.candidates.length === 0
      ) {
        const failures = [
          caption.error,
          imageVectors.error,
          (text as { error?: unknown }).error,
        ].filter((error): error is unknown => error !== undefined);
        if (failures.length > 0) {
          throw [...failures].sort((left, right) => failureRank(left) - failureRank(right))[0];
        }
        throw createKnowledgeError({
          code: 'KNOWLEDGE_NOT_FOUND',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { reason: 'empty_result' },
        });
      }
      const imageBlock = fuseImageChannels(caption.candidates, imageVectors.candidates);
      const textBlock = text.candidates.filter(
        (candidate) => candidate.segment.imageBlobRefId === null,
      );
      const fused = fuseTextAndImageBlocks(textBlock, imageBlock) as AuthorizedCandidate[];
      const internal = toPipelineSearchRequest(request, {
        requestId: context.requestId,
        workspaceId: context.workspaceId,
        memberId: context.memberId,
        models: { embeddingModel: 'image-composition' },
        mode: 'hybrid',
        limit: 10,
        knowledgeSpaceIds: [request.knowledgeSpaceId],
      });
      const finalized = finalizeSearchCandidates(internal, fused, text.rerankApplied);
      const candidates: AuthorizedCandidate[] = [];
      for (const candidate of finalized.items) {
        const current = await this.input.authorization.reauthorizeCitation(
          {
            knowledgeSpaceId: candidate.knowledgeSpaceId,
            sourceId: candidate.sourceId,
            segmentId: candidate.segmentId,
          },
          context,
        );
        if (current) candidates.push(current);
        else degraded.push('image_candidate_acl_rejected');
      }
      const durationMs = Date.now() - startedAt;
      const partial =
        caption.failed ||
        imageVectors.failed ||
        text.partial ||
        degraded.includes('image_candidate_acl_rejected');
      const citations = await this.input.citations.issueWithAudit(
        {
          searchId,
          searchMode: 'image',
          spaceId: request.knowledgeSpaceId,
          candidates,
          partial,
          durationMs,
          degradedCodes: degraded,
          now: this.input.now?.() ?? new Date(),
          deadlineAt: startedAt + 60_000,
        },
        context,
      );
      return this.response({
        searchId,
        request,
        candidates,
        citations,
        partial,
        durationMs,
        degradedCodes: degraded,
        rerankApplied: text.rerankApplied,
      });
    } catch (error) {
      await this.input.audits.appendSearch(
        {
          searchId,
          searchMode: 'image',
          spaceId: request.knowledgeSpaceId,
          outcome: 'failed',
          partial: false,
          resultCount: 0,
          degradedCodes: degraded,
          durationMs: Date.now() - startedAt,
          failureCode: problemCode(error),
        },
        context,
      );
      throw error;
    }
  }

  async dispatch(input: KnowledgeOperationInput): Promise<KnowledgeOperationResult> {
    if (input.operationId !== 'API-SEARCH-IMAGE') {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_INTERNAL_ERROR',
        requestId: input.context.requestId,
        traceId: input.context.traceId,
        details: { operationId: input.operationId, application: 's8-image-search' },
      });
    }
    const data = await this.search(input.body, input.context);
    return { status: data.partial ? 207 : 200, data };
  }
}
