import {
  ArchiveAction,
  Button,
  FilePreviewPanel,
  FormField,
  KnowledgeDataTable,
  LoadingState,
  PageHeader,
  ProblemNotice,
  Section,
  SelectInput,
  StatusTag,
  TextInput,
  knowledgeQueryKeys,
  knowledgeRequest,
  sourceFormSchema,
  submitWithProblem,
  useKnowledgeEnumLabel,
  useKnowledgeForm,
  useKnowledgeI18n,
  useKnowledgeMutation,
  useKnowledgeQuery,
  type SourceFormValues,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useState } from 'react';
import type { DirectoryRecord, SourceRecord, SpaceRecord } from '../../../lib/knowledge-types';
import { listPath, statusTone } from '../../../lib/knowledge-types';

function SourceDownloadButton({ sourceId }: { sourceId: string }) {
  const { t } = useKnowledgeI18n();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  return (
    <>
      {downloadUrl ? (
        <Button
          href={downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          size="sm"
          tone="primary"
        >
          {t('sources.download')}
        </Button>
      ) : (
        <Button
          size="sm"
          busy={busy}
          onClick={() => {
            setBusy(true);
            setProblem(null);
            void knowledgeRequest<{ url: string }>(`/v1/knowledge/sources/${sourceId}/download`, {
              method: 'POST',
              body: { disposition: 'attachment' },
            })
              .then((ticket) => setDownloadUrl(ticket.url))
              .catch(setProblem)
              .finally(() => setBusy(false));
          }}
        >
          {t('sources.download')}
        </Button>
      )}
      {problem ? <ProblemNotice error={problem} /> : null}
    </>
  );
}

export default function SourcesPage() {
  const router = useRouter();
  const { t } = useKnowledgeI18n();
  const enumLabel = useKnowledgeEnumLabel();
  const spaceId = typeof router.query.spaceId === 'string' ? router.query.spaceId : '';
  const [problem, setProblem] = useState<unknown>(null);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const space = useKnowledgeQuery<SpaceRecord>(
    knowledgeQueryKeys.spaces.detail(spaceId),
    spaceId ? `/v1/knowledge/spaces/${spaceId}` : null,
  );
  const directories = useKnowledgeQuery<{ items: DirectoryRecord[] }>(
    knowledgeQueryKeys.directories.list(spaceId),
    spaceId ? listPath(spaceId, 'directories') : null,
  );
  const sources = useKnowledgeQuery<{ items: SourceRecord[] }>(
    knowledgeQueryKeys.sources.list(spaceId),
    spaceId ? listPath(spaceId, 'sources') : null,
  );
  const form = useKnowledgeForm(sourceFormSchema, {
    defaultValues: { kind: 'text', name: '', directoryId: '' },
  });
  const createSource = useKnowledgeMutation<SourceRecord, SourceFormValues>({
    mutationFn: (values) =>
      knowledgeRequest<SourceRecord>(`/v1/knowledge/spaces/${spaceId}/sources`, {
        method: 'POST',
        body: {
          kind: values.kind,
          name: values.name,
          ...(values.directoryId ? { directoryId: values.directoryId } : {}),
          searchEnabled: true,
          metadata: {},
        },
      }),
    invalidateKeys: [knowledgeQueryKeys.sources.list(spaceId), knowledgeQueryKeys.jobs.list()],
    onSuccess: () => {
      form.reset();
    },
  });
  const deleteSource = useKnowledgeMutation<void, string>({
    mutationFn: (sourceId) =>
      knowledgeRequest<void>(`/v1/knowledge/sources/${sourceId}`, {
        method: 'DELETE',
        body: {},
      }),
    invalidateKeys: [knowledgeQueryKeys.sources.list(spaceId), knowledgeQueryKeys.jobs.list()],
  });

  const submitSource = form.handleSubmit(async (values) => {
    await submitWithProblem(
      async () => {
        await createSource.mutateAsync(values);
      },
      setProblem,
      form,
    );
  });

  async function removeSource(source: SourceRecord) {
    if (!window.confirm(t('sources.confirmDelete', { name: source.name }))) return;
    await submitWithProblem(async () => {
      await deleteSource.mutateAsync(source.id);
    }, setProblem);
  }

  return (
    <>
      <Head>
        <title>
          {space.data ? t('sources.title', { name: space.data.name }) : t('sources.fallbackTitle')}
        </title>
      </Head>
      <PageHeader
        eyebrow={t('sources.eyebrow')}
        title={t('sources.heading')}
        description={t('sources.description')}
      />
      <ProblemNotice
        error={
          space.error ??
          directories.error ??
          sources.error ??
          problem ??
          createSource.error ??
          deleteSource.error
        }
        onRetry={() => void sources.refetch()}
      />
      <Section title={t('sources.createTitle')} meta={t('sources.createMeta')}>
        <form className="form-band" onSubmit={submitSource}>
          <div className="form-intro">
            <h2>{t('sources.formTitle')}</h2>
            <p>{t('sources.formDescription')}</p>
          </div>
          <div className="form-fields">
            <FormField
              control={form.control}
              name="name"
              label={t('sources.name')}
              render={(field) => (
                <TextInput
                  {...field}
                  required
                  maxLength={240}
                  value={String(field.value)}
                  onChange={(event) => field.onChange(event.target.value)}
                />
              )}
            />
            <FormField
              control={form.control}
              name="kind"
              label={t('sources.kind')}
              render={(field) => (
                <SelectInput
                  name={field.name}
                  value={String(field.value)}
                  onBlur={field.onBlur}
                  onChange={(event) => field.onChange(event.target.value)}
                >
                  <option value="text">{t('enum.text')}</option>
                  <option value="file">{t('enum.file')}</option>
                  <option value="url">{t('enum.url')}</option>
                  <option value="template">{t('enum.template')}</option>
                  <option value="image">{t('enum.image')}</option>
                </SelectInput>
              )}
            />
            <FormField
              control={form.control}
              name="directoryId"
              label={t('sources.directory')}
              render={(field) => (
                <SelectInput
                  name={field.name}
                  value={String(field.value)}
                  onBlur={field.onBlur}
                  onChange={(event) => field.onChange(event.target.value)}
                >
                  <option value="">{t('sources.noDirectory')}</option>
                  {directories.data?.items.map((directory) => (
                    <option key={directory.id} value={directory.id}>
                      {directory.name}
                    </option>
                  ))}
                </SelectInput>
              )}
            />
          </div>
          <div className="form-actions">
            <Button type="submit" tone="primary" busy={createSource.isLoading}>
              {t('sources.create')}
            </Button>
          </div>
        </form>
      </Section>
      <Section
        title={t('sources.register')}
        meta={sources.data ? t('common.records', { count: sources.data.items.length }) : undefined}
      >
        <div className="inline-actions">
          <Button href={`/spaces/${spaceId}/import`} size="sm" tone="primary">
            {t('sources.selectFile')}
          </Button>
          <ArchiveAction spaceId={spaceId} sourceIds={selectedSourceIds} />
          <span>{t('sources.selectedCount', { count: selectedSourceIds.length })}</span>
        </div>
        {sources.isLoading ? (
          <LoadingState />
        ) : (
          <KnowledgeDataTable
            rows={sources.data?.items ?? []}
            rowKey={(source) => source.id}
            empty={t('sources.empty')}
            caption={t('sources.register')}
            columns={[
              {
                key: 'select',
                label: t('sources.selectFile'),
                render: (source) => (
                  <input
                    type="checkbox"
                    aria-label={`${t('sources.selectFile')} ${source.name}`}
                    checked={selectedSourceIds.includes(source.id)}
                    onChange={(event) =>
                      setSelectedSourceIds((current) =>
                        event.target.checked
                          ? [...current, source.id]
                          : current.filter((id) => id !== source.id),
                      )
                    }
                  />
                ),
              },
              { key: 'name', label: t('sources.columnName'), render: (source) => source.name },
              {
                key: 'kind',
                label: t('sources.columnKind'),
                render: (source) => enumLabel(source.kind),
              },
              {
                key: 'status',
                label: t('sources.columnStatus'),
                render: (source) => (
                  <StatusTag
                    value={source.processingStatus}
                    tone={statusTone(source.processingStatus)}
                  />
                ),
              },
              {
                key: 'permission',
                label: t('sources.columnPermission'),
                render: (source) =>
                  `${enumLabel(source.permissionState)} / r${source.permissionRevision}`,
              },
              {
                key: 'actions',
                label: t('sources.columnActions'),
                render: (source) => (
                  <div className="inline-actions">
                    <FilePreviewPanel sourceId={source.id} />
                    <SourceDownloadButton sourceId={source.id} />
                    <Button href={`/spaces/${spaceId}/segments?sourceId=${source.id}`} size="sm">
                      {t('sources.actionSegments')}
                    </Button>
                    <Button
                      size="sm"
                      tone="danger"
                      busy={deleteSource.isLoading}
                      onClick={() => void removeSource(source)}
                    >
                      {t('sources.actionDelete')}
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        )}
      </Section>
    </>
  );
}
