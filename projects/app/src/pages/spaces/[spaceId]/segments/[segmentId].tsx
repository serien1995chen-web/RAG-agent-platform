import {
  LoadingState,
  PageHeader,
  ProblemNotice,
  S6SegmentIndexEditor,
  Section,
  knowledgeQueryKeys,
  knowledgeRequest,
  useKnowledgeI18n,
  useKnowledgeMutation,
  useKnowledgeQuery,
  type S6SegmentIndexView,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';
import type { SegmentHistoryRecord, SegmentRecord } from '../../../../lib/knowledge-types';

export default function SegmentEditPage() {
  const router = useRouter();
  const { t } = useKnowledgeI18n();
  const spaceId = typeof router.query.spaceId === 'string' ? router.query.spaceId : '';
  const segmentId = typeof router.query.segmentId === 'string' ? router.query.segmentId : '';
  const segment = useKnowledgeQuery<SegmentRecord>(
    knowledgeQueryKeys.segments.detail(segmentId),
    segmentId ? `/v1/knowledge/segments/${segmentId}` : null,
  );
  const history = useKnowledgeQuery<{ items: SegmentHistoryRecord[] }>(
    knowledgeQueryKeys.segments.history(segmentId),
    segmentId ? `/v1/knowledge/segments/${segmentId}/history` : null,
  );
  const update = useKnowledgeMutation<
    SegmentRecord,
    { question: string; answer: string; searchEnabled: boolean; version: number }
  >({
    mutationFn: (input) =>
      knowledgeRequest<SegmentRecord>(`/v1/knowledge/segments/${segmentId}`, {
        method: 'PATCH',
        body: input,
      }),
    invalidateKeys: [knowledgeQueryKeys.jobs.list()],
    onSuccess: () => {
      void segment.refetch();
      void history.refetch();
    },
  });
  const indexMutation = useKnowledgeMutation<
    SegmentRecord,
    {
      mode: 'create' | 'update';
      input: {
        indexId: string;
        type: S6SegmentIndexView['type'];
        text: string;
        modelId: string;
        version: number;
      };
    }
  >({
    mutationFn: ({ mode, input }) =>
      knowledgeRequest<SegmentRecord>(
        `/v1/knowledge/segments/${segmentId}/indexes${mode === 'update' ? `/${input.indexId}` : ''}`,
        { method: mode === 'create' ? 'POST' : 'PATCH', body: input },
      ),
    invalidateKeys: [knowledgeQueryKeys.jobs.list()],
    onSuccess: () => void segment.refetch(),
  });
  const deleteIndex = useKnowledgeMutation<void, string>({
    mutationFn: (indexId) =>
      knowledgeRequest<void>(`/v1/knowledge/segments/${segmentId}/indexes/${indexId}`, {
        method: 'DELETE',
        body: { version: segment.data?.version },
      }),
    invalidateKeys: [knowledgeQueryKeys.jobs.list()],
    onSuccess: () => void segment.refetch(),
  });
  const reindex = useKnowledgeMutation<
    void,
    'manual' | 'model_change' | 'synonym_change' | 'repair'
  >({
    mutationFn: (reason) =>
      knowledgeRequest<void>(`/v1/knowledge/segments/${segmentId}/reindex`, {
        method: 'POST',
        body: { reason: reason === 'manual' ? 'manual' : 'repair', version: segment.data?.version },
      }),
    invalidateKeys: [knowledgeQueryKeys.jobs.list()],
    onSuccess: () => void segment.refetch(),
  });
  const error =
    segment.error ??
    history.error ??
    update.error ??
    indexMutation.error ??
    deleteIndex.error ??
    reindex.error;
  const busy =
    update.isLoading || indexMutation.isLoading || deleteIndex.isLoading || reindex.isLoading;

  return (
    <>
      <Head>
        <title>{segment.data ? t('s6.segment.title') : t('s6.segment.fallbackTitle')}</title>
      </Head>
      <PageHeader
        eyebrow={t('segments.eyebrow')}
        title={t('s6.segment.title')}
        description={spaceId ? `/spaces/${spaceId}` : undefined}
      />
      <ProblemNotice error={error} onRetry={() => void segment.refetch()} />
      <Section title={t('s6.segment.contentTitle')}>
        {segment.isLoading || !segment.data ? (
          <LoadingState />
        ) : (
          <S6SegmentIndexEditor
            segment={segment.data}
            history={history.data?.items ?? []}
            busy={busy}
            onSave={(input) => update.mutateAsync(input).then(() => undefined)}
            onIndexUpsert={(input) =>
              indexMutation
                .mutateAsync({
                  mode: segment.data.indexes.some((index) => index.indexId === input.indexId)
                    ? 'update'
                    : 'create',
                  input,
                })
                .then(() => undefined)
            }
            onIndexDelete={(indexId) => deleteIndex.mutateAsync(indexId)}
            onReindex={(reason) => reindex.mutateAsync(reason)}
          />
        )}
      </Section>
    </>
  );
}
