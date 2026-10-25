import {
  Button,
  Field,
  FormField,
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
    if (!window.confirm(t('segments.confirmDelete', { order: segment.order }))) return;
    await submitWithProblem(async () => {
      await deleteSegment.mutateAsync(segment.id);
    }, setProblem);
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
      />
      <ProblemNotice
        error={
          space.error ??
          sources.error ??
          segments.error ??
          problem ??
          createSegment.error ??
          deleteSegment.error
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

      <Section title={t('segments.createTitle')} meta={t('segments.createMeta')}>
        <form className="form-band" onSubmit={submitSegment}>
          <div className="form-intro">
            <h2>{t('segments.formTitle')}</h2>
            <p>{t('segments.formDescription')}</p>
          </div>
          <div className="form-fields">
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
                  maxLength={100000}
                  value={String(field.value)}
                  onChange={(event) => field.onChange(event.target.value)}
                />
              )}
            />
          </div>
          <div className="form-actions">
            <Button
              type="submit"
              tone="primary"
              busy={createSegment.isLoading}
              disabled={!sourceId}
            >
              {t('segments.create')}
            </Button>
          </div>
        </form>
      </Section>

      <Section
        title={t('segments.register')}
        meta={
          segments.data ? t('common.records', { count: segments.data.items.length }) : undefined
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
                  <Button
                    size="sm"
                    tone="danger"
                    busy={deleteSegment.isLoading}
                    onClick={() => void removeSegment(segment)}
                  >
                    {t('segments.actionDelete')}
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Section>
    </>
  );
}
