import type { CitationApi, SearchApiItem, SearchImagePreviewApi } from '@kb/contracts';
import type { AuthorizedCandidate } from '@kb/search';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { S7ImagePreviewPort } from './s7-search.ports';

export const SEARCH_IMAGE_PREVIEW_TTL_SECONDS = 300;

const STORAGE_METADATA_KEY =
  /^(?:object_?key|final_?object_?key|pending_?object_?key|storage_?key|bucket|signed_?url|ticket|ticket_?id)$/i;
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu;
const INTERNAL_OBJECT_PATH = /\b(?:ws|dataset)\/[A-Za-z0-9._~%/:-]+\/[^\s)"'<>]+/gu;
const INTERNAL_OBJECT_PATH_TEST = /\b(?:ws|dataset)\/[A-Za-z0-9._~%/:-]+\/[^\s)"'<>]+/u;

function internalStorageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return [...url.searchParams.keys()].some((key) =>
      /^(?:ticket|signature|x-amz-signature|x-amz-credential)$/i.test(key),
    );
  } catch {
    return false;
  }
}

function publicImageTarget(value: string): boolean {
  if (/^data:image\//i.test(value)) return true;
  return /^https?:\/\//i.test(value) && !internalStorageUrl(value);
}

export function sanitizeSearchContent(content: string): string {
  return content
    .replace(MARKDOWN_IMAGE, (match, alt: string, target: string) =>
      publicImageTarget(target) ? match : alt,
    )
    .replace(INTERNAL_OBJECT_PATH, ' ')
    .trim();
}

function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (depth > 12) return null;
  if (typeof value === 'string') return sanitizeSearchContent(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeMetadata(item, depth + 1));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !STORAGE_METADATA_KEY.test(key))
      .map(([key, item]) => [key, sanitizeMetadata(item, depth + 1)]),
  );
}

function sanitizeCitation(citation: CitationApi): CitationApi {
  const sourceUrl =
    citation.sourceUrl &&
    !internalStorageUrl(citation.sourceUrl) &&
    !INTERNAL_OBJECT_PATH_TEST.test(citation.sourceUrl)
      ? citation.sourceUrl
      : null;
  return {
    ...citation,
    sourceUrl,
  };
}

export function searchCandidateKey(candidate: AuthorizedCandidate): string {
  return `${candidate.knowledgeSpaceId}:${candidate.segmentId}`;
}

export function buildPublicSearchItem(input: {
  candidate: AuthorizedCandidate;
  citation: CitationApi;
  imagePreview?: SearchImagePreviewApi;
}): SearchApiItem {
  const { candidate } = input;
  return {
    segment: {
      id: candidate.segment.id,
      workspaceId: candidate.segment.workspaceId,
      knowledgeSpaceId: candidate.knowledgeSpaceId,
      sourceId: candidate.sourceId,
      searchEnabled: candidate.segment.searchEnabled,
      order: candidate.segment.order,
      question: sanitizeSearchContent(candidate.segment.question),
      answer: sanitizeSearchContent(candidate.segment.answer),
      content: sanitizeSearchContent(candidate.segment.content),
      metadata: sanitizeMetadata(candidate.segment.metadata) as Record<string, unknown>,
      indexes: candidate.segment.indexes.map((entry) => ({
        indexId: entry.indexId,
        type: entry.type as
          | 'default'
          | 'custom'
          | 'question'
          | 'summary'
          | 'image'
          | 'image_caption',
        modelId: entry.modelId,
        dimension: entry.dimension,
        storageType: entry.dimension === 3072 ? ('halfvec' as const) : ('vector' as const),
        vectorProfile: entry.vectorProfile as
          | 'knowledge_segment_vectors_768'
          | 'knowledge_segment_vectors_1024'
          | 'knowledge_segment_vectors_1536'
          | 'knowledge_segment_vectors_3072',
        vectorId: entry.vectorId,
        text: sanitizeSearchContent(entry.text),
        version: entry.version,
      })),
      indexStatus: candidate.segment.indexStatus,
      indexErrorCode: candidate.segment.indexErrorCode,
      imageBlobRefId: candidate.segment.imageBlobRefId,
      version: candidate.segment.version,
    },
    score: candidate.rerankScore ?? candidate.embeddingScore ?? candidate.score,
    citation: sanitizeCitation(input.citation),
    ...(input.imagePreview ? { imagePreview: input.imagePreview } : {}),
  };
}

export async function issueSearchImagePreviews(input: {
  candidates: readonly AuthorizedCandidate[];
  previews?: S7ImagePreviewPort;
  context: TenantContext;
}): Promise<{
  items: ReadonlyMap<string, SearchImagePreviewApi>;
  degradedCodes: string[];
}> {
  const items = new Map<string, SearchImagePreviewApi>();
  let failed = false;
  await Promise.all(
    input.candidates.map(async (candidate) => {
      if (!candidate.segment.imageBlobRefId) return;
      if (!input.previews) {
        failed = true;
        return;
      }
      try {
        const issued = await input.previews.issueImage({
          workspaceId: input.context.workspaceId,
          blobId: candidate.segment.imageBlobRefId,
          sourceId: candidate.sourceId,
          knowledgeSpaceId: candidate.knowledgeSpaceId,
          ttlSeconds: SEARCH_IMAGE_PREVIEW_TTL_SECONDS,
          context: input.context,
        });
        items.set(searchCandidateKey(candidate), {
          url: issued.url,
          expiresAt: issued.expiresAt,
        });
      } catch {
        failed = true;
      }
    }),
  );
  return {
    items,
    degradedCodes: failed ? ['image_preview_unavailable'] : [],
  };
}
