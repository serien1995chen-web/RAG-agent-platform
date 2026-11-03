import {
  AddIcon,
  Button,
  ConfirmDialog,
  Field,
  FormField,
  FormDrawer,
  KnowledgeDataTable,
  LoadingState,
  PageHeader,
  ProblemNotice,
  Section,
  SelectInput,
  StatusTag,
  TextArea,
  TextInput,
  knowledgeQueryKeys,
  knowledgeRequest,
  segmentFormSchema,
  submitWithProblem,
  useKnowledgeForm,
  useKnowledgeI18n,
  useKnowledgeMutation,
  useKnowledgeQuery,
  type SegmentFormValues,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import type {
  BatchActionResult,
  PageInfo,
  SegmentRecord,
  SourceRecord,
  SpaceRecord,
} from '../../../lib/knowledge-types';
import { listPath, statusTone } from '../../../lib/knowledge-types';

type SegmentResponse = { items: SegmentRecord[]; pageInfo: PageInfo };

export default function SegmentsPage() {
  const router = useRouter();
  const { t } = useKnowledgeI18n();
  const spaceId = typeof router.query.spaceId === 'string' ? router.query.spaceId : '';
  const sourceFromQuery = typeof router.query.sourceId === 'string' ? router.query.sourceId : '';
  const [sourceId, setSourceId] = useState(sourceFromQuery);
  const [problem, setProblem] = useState<unknown>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pendingSegment, setPendingSegment] = useState<SegmentRecord | null>(null);
  const space = useKnowledgeQuery<SpaceRecord>(
    knowledgeQueryKeys.spaces.detail(spaceId),
    spaceId ? `/v1/knowledge/spaces/${spaceId}` : null,
  );
  const sources = useKnowledgeQuery<{ items: SourceRecord[] }>(
    knowledgeQueryKeys.sources.list(spaceId),
    spaceId ? listPath(spaceId, 'sources') : null,
  );
  const segments = useKnowledgeQuery<SegmentResponse>(
    knowledgeQueryKeys.sources.segments(sourceId),
    sourceId ? `/v1/knowledge/sources/${sourceId}/segments?limit=200&sort=order` : null,
  );
  const form = useKnowledgeForm(segmentFormSchema, {
    defaultValues: { question: '', answer: '' },
  });
  const createSegment = useKnowledgeMutation<SegmentRecord, SegmentFormValues>({
    mutationFn: (values) =>
      knowledgeRequest<SegmentRecord>(`/v1/knowledge/sources/${sourceId}/segments`, {
        method: 'POST',
        body: { ...values, searchEnabled: true, metadata: {} },
      }),
    invalidateKeys: [knowledgeQueryKeys.sources.segments(sourceId), knowledgeQueryKeys.jobs.list()],
    onSuccess: () => {
      form.reset();
      setCreateOpen(false);
    },
  });
  const deleteSegment = useKnowledgeMutation<void, string>({
    mutationFn: (segmentId) =>
      knowledgeRequest<void>(`/v1/knowledge/segments/${segmentId}`, {
        method: 'DELETE',
        body: {},
      }),
    invalidateKeys: [knowledgeQueryKeys.sources.segments(sourceId), knowledgeQueryKeys.jobs.list()],
  });
  const batch = useKnowledgeMutation<
    BatchActionResult,
    { action: 'reindex' | 'delete'; items: Array<{ segmentId: string; version: number }> }
  >({
    mutationFn: (input) =>
      knowledgeRequest<BatchActionResult>('/v1/knowledge/segments/batch-actions', {
        method: 'POST',
        body: input,
      }),
    invalidateKeys: [knowledgeQueryKeys.sources.segments(sourceId), knowledgeQueryKeys.jobs.list()],
    onSuccess: () => setSelectedIds([]),
  });

  useEffect(() => {
    if (!sourceId && sources.data?.items[0]) {
      setSourceId(sources.data.items[0].id);
    }
  }, [sourceId, sources.data]);

  const submitSegment = form.handleSubmit(async (values) => {
    await submitWithProblem(
      async () => {
        await createSegment.mutateAsync(values);
      },
      setProblem,
      form,
    );
  });

  async function removeSegment(segment: SegmentRecord) {
    await submitWithProblem(async () => {
      await deleteSegment.mutateAsync(segment.id);
    }, setProblem);
    setDeleteOpen(false);
    setPendingSegment(null);
  }

  return (
    <>
      <Head>
        <title>
          {space.data
            ? t('segments.title', { name: space.data.name })
            : t('segments.fallbackTitle')}
        </title>
      </Head>
      <PageHeader
        eyebrow={t('segments.eyebrow')}
        title={t('segments.heading')}
        description={t('segments.description')}
        actions={
          <Button tone="primary" isDisabled={!sourceId} onClick={() => setCreateOpen(true)}>
            <AddIcon boxSize={3.5} mr={2} />
            {t('segments.create')}
          </Button>
        }
      />
      <ProblemNotice
        error={
          space.error ??
          sources.error ??
          segments.error ??
          problem ??
          createSegment.error ??
          deleteSegment.error ??
          batch.error
        }
        onRetry={() => void segments.refetch()}
      />
      <div className="selector-row">
        <Field label={t('segments.source')}>
          <SelectInput
            value={sourceId}
            onChange={(event) => {
              const value = event.target.value;
              setSourceId(value);
              void router.replace(
                `/spaces/${spaceId}/segments${value ? `?sourceId=${value}` : ''}`,
                undefined,
                { shallow: true },
              );
            }}
          >
            <option value="">{t('segments.selectSource')}</option>
            {sources.data?.items.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </SelectInput>
        </Field>
      </div>

      <Section
        title={t('segments.register')}
        meta={
          segments.data ? t('common.records', { count: segments.data.items.length }) : undefined
        }
        actions={
          <Button
            busy={batch.isLoading}
            disabled={sourceId === '' || selectedIds.length === 0}
            onClick={() => {
              const versions = new Map(
                (segments.data?.items ?? []).map((segment) => [segment.id, segment.version]),
              );
              void batch.mutateAsync({
                action: 'reindex',
                items: selectedIds.map((segmentId) => ({
                  segmentId,
                  version: versions.get(segmentId) ?? 1,
                })),
              });
            }}
          >
            {t('segments.reindexSelected')}
          </Button>
        }
      >
        {segments.isLoading ? (
          <LoadingState />
        ) : (
          <KnowledgeDataTable
            rows={segments.data?.items ?? []}
            rowKey={(segment) => segment.id}
            empty={t('segments.empty')}
            caption={t('segments.register')}
            columns={[
              {
                key: 'select',
                label: t('segments.select'),
                render: (segment) => (
                  <input
                    type="checkbox"
                    aria-label={`${t('segments.select')} ${segment.order}`}
                    checked={selectedIds.includes(segment.id)}
                    onChange={(event) =>
                      setSelectedIds((current) =>
                        event.target.checked
                          ? [...new Set([...current, segment.id])]
                          : current.filter((id) => id !== segment.id),
                      )
                    }
                  />
                ),
              },
              {
                key: 'order',
                label: t('segments.columnOrder'),
                render: (segment) => segment.order,
              },
              {
                key: 'question',
                label: t('segments.columnQuestion'),
                render: (segment) => segment.question,
              },
              {
                key: 'status',
                label: t('segments.columnIndexStatus'),
                render: (segment) => (
                  <StatusTag value={segment.indexStatus} tone={statusTone(segment.indexStatus)} />
                ),
              },
              {
                key: 'search',
                label: t('segments.columnSearch'),
                render: (segment) =>
                  segment.searchEnabled ? t('enum.enabled') : t('enum.disabled'),
              },
              {
                key: 'version',
                label: t('segments.columnVersion'),
                render: (segment) => segment.version,
              },
              {
                key: 'actions',
                label: t('segments.columnActions'),
                render: (segment) => (
                  <div className="row-actions">
                    <Button
                      size="sm"
                      onClick={() => void router.push(`/spaces/${spaceId}/segments/${segment.id}`)}
                    >
                      {t('segments.actionEdit')}
                    </Button>
                    <Button
                      size="sm"
                      tone="danger"
                      busy={deleteSegment.isLoading}
                      onClick={() => {
                        setPendingSegment(segment);
                        setDeleteOpen(true);
                      }}
                    >
                      {t('segments.actionDelete')}
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        )}
      </Section>

      <FormDrawer
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t('segments.formTitle')}
        description={t('segments.formDescription')}
        size="lg"
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)}>{t('common.cancel')}</Button>
            <Button
              type="submit"
              form="segment-create-form"
              tone="primary"
              busy={createSegment.isLoading}
            >
              {t('segments.create')}
            </Button>
          </>
        }
      >
        <form id="segment-create-form" className="form-stack" onSubmit={submitSegment}>
          <FormField
            control={form.control}
            name="question"
            label={t('segments.question')}
            render={(field) => (
              <TextInput
                {...field}
                required
                maxLength={100000}
                value={String(field.value)}
                onChange={(event) => field.onChange(event.target.value)}
              />
            )}
          />
          <FormField
            control={form.control}
            name="answer"
            label={t('segments.answer')}
            render={(field) => (
              <TextArea
                {...field}
                required
                minH="220px"
                maxLength={100000}
                value={String(field.value)}
                onChange={(event) => field.onChange(event.target.value)}
              />
            )}
          />
        </form>
      </FormDrawer>

      <ConfirmDialog
        isOpen={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={async () => {
          if (pendingSegment) await removeSegment(pendingSegment);
        }}
        title={t('segments.deleteTitle')}
        description={
          pendingSegment ? t('segments.confirmDelete', { order: pendingSegment.order }) : ''
        }
        confirmLabel={t('segments.actionDelete')}
        busy={deleteSegment.isLoading}
        destructive
      />
    </>
  );
}
