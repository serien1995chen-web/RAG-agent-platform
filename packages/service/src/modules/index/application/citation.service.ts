import { ApiErrorException, CitationSchema, createApiError } from '@kb/contracts';
import type { Citation, CitationScore } from '@kb/contracts';
import type { ObjectRef, RequestContext } from '../../../ports/types';
import { DEFAULT_PREVIEW_TTL_SECONDS, assertCitationSafe } from '../domain/citation';

export interface ResolvedCitationInput {
  dataId: string;
  chunkIndex: number;
  datasetId: string;
  collectionId: string;
  collectionName: string;
  sourceName: string;
  sourceType: Citation['sourceType'];
  quoteText: string;
  updateTime: string;
  scores: CitationScore[];
  imageIds?: string[];
}

export interface CitationServiceDeps {
  resolveImageRef(
    imageId: string,
    context: RequestContext,
  ): Promise<{ ref: ObjectRef; datasetId: string } | null>;
  presignPreview?: (
    ref: ObjectRef,
    tenant: { teamId: string; datasetId?: string },
    expiresSeconds: number,
  ) => Promise<string>;
  previewTtlSeconds?: number;
}

export class CitationService {
  constructor(private readonly deps: CitationServiceDeps) {}

  async build(input: {
    items: ResolvedCitationInput[];
    context: RequestContext;
  }): Promise<Citation[]> {
    const ttl = this.deps.previewTtlSeconds ?? DEFAULT_PREVIEW_TTL_SECONDS;
    const output: Citation[] = [];

    for (const item of input.items) {
      const base: Citation = {
        dataId: item.dataId,
        chunkIndex: item.chunkIndex,
        datasetId: item.datasetId,
        collectionId: item.collectionId,
        collectionName: item.collectionName,
        sourceName: item.sourceName,
        sourceType: item.sourceType,
        quoteText: item.quoteText,
        updateTime: item.updateTime,
        scores: item.scores,
      };
      assertCitationSafe(base as unknown as Record<string, unknown>, input.context.requestId);

      const imagePreviewUrls: string[] = [];
      if (this.deps.presignPreview && item.imageIds) {
        for (const imageId of item.imageIds) {
          const resolved = await this.deps.resolveImageRef(imageId, input.context);
          if (!resolved) continue;
          imagePreviewUrls.push(
            await this.deps.presignPreview(
              resolved.ref,
              { teamId: input.context.tenant.teamId, datasetId: item.datasetId },
              ttl,
            ),
          );
        }
      }

      const citation: Citation = imagePreviewUrls.length > 0 ? { ...base, imagePreviewUrls } : base;
      assertCitationSafe(citation as unknown as Record<string, unknown>, input.context.requestId);
      const parsed = CitationSchema.safeParse(citation);
      if (!parsed.success) {
        throw new ApiErrorException(
          createApiError({
            code: 501070,
            requestId: input.context.requestId,
            params: { resourceType: 'citation', resourceId: item.dataId },
          }),
        );
      }
      output.push(parsed.data);
    }

    return output;
  }
}
