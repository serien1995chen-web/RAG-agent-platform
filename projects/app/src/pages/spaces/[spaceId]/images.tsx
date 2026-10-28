import type { ImageSearchApiRequest, SearchApiResponse } from '@kb/contracts';
import {
  buildS8ImageRequest,
  IdempotencyKeyBuffer,
  knowledgeMultipartUpload,
  knowledgeQueryKeys,
  knowledgeRequest,
  S8ImagesWorkbench,
  useKnowledgeI18n,
  useKnowledgeQuery,
  useKnowledgeQueries,
  type S8ImageGalleryItem,
  type S8ImagesWorkbenchLabels,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useMemo, useRef, useState } from 'react';
import type { JobRecord, SegmentRecord, SourceRecord } from '../../../lib/knowledge-types';

interface PageInfo {
  nextCursor: string | null;
  hasMore: boolean;
}

interface SourceListResponse {
  items: Array<SourceRecord & { blobRefId?: string | null; mimeType?: string }>;
  pageInfo: PageInfo;
}

interface SegmentListResponse {
  items: Array<
    SegmentRecord & {
      imageBlobRefId?: string | null;
      imageDescription?: string | null;
    }
  >;
  pageInfo: PageInfo;
}

interface PreviewTicket {
  url: string;
  expiresAt: string;
}

function queryString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function statusOf(value: unknown): 'pending' | 'indexed' | 'error' {
  return value === 'indexed' || value === 'error' ? value : 'pending';
}

export default function ImagesPage() {
  const router = useRouter();
  const { t } = useKnowledgeI18n();
  const spaceId = queryString(router.query.spaceId);
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<SearchApiResponse | null>(null);
  const [providerError, setProviderError] = useState(false);
  const [searchProblem, setSearchProblem] = useState<unknown>();
  const [retryInput, setRetryInput] = useState<{
    query: string;
    imageUploadIds: readonly string[];
  } | null>(null);
  const imageKeys = useRef(new IdempotencyKeyBuffer());
  const sources = useKnowledgeQuery<SourceListResponse>(
    knowledgeQueryKeys.imageSources.list(spaceId, { kind: 'image', limit: 100 }),
    spaceId ? `/v1/knowledge/spaces/${spaceId}/sources?kind=image&limit=100` : null,
  );
  const sourceItems = useMemo(() => sources.data?.items ?? [], [sources.data?.items]);
  const segmentRequests = useMemo(
    () =>
      sourceItems.map((source) => ({
        key: knowledgeQueryKeys.imageSegments.list(source.id, { limit: 100 }),
        path: `/v1/knowledge/sources/${source.id}/segments?limit=100&sort=order`,
      })),
    [sourceItems],
  );
  const segmentQueries = useKnowledgeQueries<SegmentListResponse>(segmentRequests);

  const items = useMemo<S8ImageGalleryItem[]>(
    () =>
      sourceItems.flatMap((source, index) => {
        const blobId = source.blobRefId ?? '';
        if (!blobId) return [];
        const segment = segmentQueries[index]?.data?.items.find(
          (item) => item.sourceId === source.id,
        );
        return [
          {
            id: source.id,
            imageBlobRefId: blobId,
            alt: source.name || `Image ${index + 1}`,
            caption: segment?.imageDescription ?? segment?.content ?? '',
            captionStatus: statusOf(segment?.metadata?.captionStatus),
            vectorStatus: statusOf(segment?.metadata?.vectorStatus),
          },
        ];
      }),
    [segmentQueries, sourceItems],
  );

  const upload = async (files: readonly File[]) => {
    if (!spaceId) return [];
    const uploadIds: string[] = [];
    for (const file of files) {
      const result = await knowledgeMultipartUpload(file, { knowledgeSpaceId: spaceId });
      uploadIds.push(result.blobId);
    }
    await knowledgeRequest<JobRecord>(`/v1/knowledge/spaces/${spaceId}/import/files`, {
      method: 'POST',
      body: {
        uploadIds,
        parseProvider: 'liteparse',
        parseConfig: {},
        chunking: {
          trainingType: 'chunk',
          chunkSettingMode: 'auto',
        },
      },
    });
    await sources.refetch();
    await Promise.all(segmentQueries.map((query) => query.refetch()));
    return uploadIds;
  };

  const preview = async (item: S8ImageGalleryItem) => {
    const ticket = await knowledgeRequest<PreviewTicket>(
      `/v1/knowledge/files/${item.imageBlobRefId}/preview`,
      {
        method: 'POST',
        body: { ttlSeconds: 300 },
      },
    );
    return ticket.url;
  };

  const search = async (input: { query: string; imageUploadIds: readonly string[] }) => {
    if (!spaceId) return;
    setRetryInput(input);
    setSearching(true);
    setProviderError(false);
    setSearchProblem(undefined);
    try {
      const request: ImageSearchApiRequest = buildS8ImageRequest({
        knowledgeSpaceId: spaceId,
        knowledgeSpaceIds: [spaceId],
        query: input.query,
        tokenBudget: 5_000,
        roundTokenBudget: 5_000,
        maxRounds: 3,
        stopWhenNoNewEvidence: true,
        similarity: 0.2,
        embeddingWeight: 0.5,
        usingRerank: false,
        rerankWeight: 0.5,
        imageUploadIds: [...input.imageUploadIds],
      });
      setSearchResult(
        await knowledgeRequest<SearchApiResponse>('/v1/knowledge/search/image', {
          method: 'POST',
          body: request,
          idempotencyKey: imageKeys.current.keyFor(request),
        }),
      );
    } catch (error) {
      setSearchProblem(error);
      setProviderError(false);
    } finally {
      setSearching(false);
    }
  };

  const labels: S8ImagesWorkbenchLabels = {
    title: t('s8.images.title'),
    description: t('s8.images.description'),
    uploadTitle: t('s8.images.uploadTitle'),
    uploadHint: t('s8.images.uploadHint'),
    choose: t('s8.images.choose'),
    upload: t('s8.images.upload'),
    uploading: t('s8.images.uploading'),
    uploaded: t('s8.images.uploaded'),
    uploadFailed: t('s8.images.uploadFailed'),
    invalidType: t('s8.images.invalidType'),
    tooLarge: t('s8.images.tooLarge'),
    tooMany: t('s8.images.tooMany'),
    searchTitle: t('s8.images.searchTitle'),
    query: t('s8.images.query'),
    queryPlaceholder: t('s8.images.queryPlaceholder'),
    selectedImages: t('s8.images.selectedImages'),
    search: t('s8.images.search'),
    searching: t('s8.images.searching'),
    partial: t('s8.images.partial'),
    providerError: t('s8.images.providerError'),
    retry: t('s8.images.retry'),
    empty: t('s8.images.empty'),
    preview: t('s8.images.preview'),
    loadingPreview: t('s8.images.loadingPreview'),
    previewExpired: t('s8.images.previewExpired'),
    caption: t('s8.images.caption'),
    captionStatus: t('s8.images.captionStatus'),
    vectorStatus: t('s8.images.vectorStatus'),
    close: t('s8.images.close'),
  };

  return (
    <>
      <Head>
        <title>{t('s8.images.title')}</title>
      </Head>
      <S8ImagesWorkbench
        spaceId={spaceId}
        items={items}
        labels={labels}
        busy={searching}
        partial={searchResult?.partial ?? false}
        providerError={providerError}
        error={searchProblem}
        searchResults={(searchResult?.items ?? []).map((item) => ({
          id: item.segment.id,
          title: item.citation.title,
          caption: item.segment.content,
          citationId: item.citation.citationId,
        }))}
        onUpload={upload}
        onPreview={preview}
        onSearch={search}
        onRetry={() => {
          if (retryInput) void search(retryInput);
        }}
      />
    </>
  );
}
