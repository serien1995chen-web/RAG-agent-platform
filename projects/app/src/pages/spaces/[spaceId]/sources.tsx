import {
  AddIcon,
  ArchiveAction,
  Button,
  CatalogBatchResult,
  CatalogMoveControl,
  ConfirmDialog,
  DeleteIcon,
  DownloadIcon,
  EditIcon,
  FilePreviewPanel,
  FormField,
  FormDrawer,
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
import type { BatchActionResult } from '../../../lib/knowledge-types';
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
  const [batchTarget, setBatchTarget] = useState('');
  const [batchResult, setBatchResult] = useState<BatchActionResult | null>(null);
  const [batchProblem, setBatchProblem] = useState<unknown>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [directoryName, setDirectoryName] = useState('');
  const [directoryParentId, setDirectoryParentId] = useState('');
  const [editingDirectory, setEditingDirectory] = useState<DirectoryRecord | null>(null);
  const [pendingSource, setPendingSource] = useState<SourceRecord | null>(null);
  const [pendingDirectory, setPendingDirectory] = useState<DirectoryRecord | null>(null);
  const [deleteSourceOpen, setDeleteSourceOpen] = useState(false);
  const [deleteDirectoryOpen, setDeleteDirectoryOpen] = useState(false);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [directoryBusy, setDirectoryBusy] = useState(false);
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
      setSourceOpen(false);
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

  const runSourceBatch = async (action: 'move' | 'delete') => {
    if (selectedSourceIds.length === 0) return;
    setBatchBusy(true);
    setBatchProblem(null);
    try {
      const versions = Object.fromEntries(
        selectedSourceIds.map((id) => [
          id,
          sources.data?.items.find((source) => source.id === id)?.version ?? 0,
        ]),
      );
      const result = await knowledgeRequest<BatchActionResult>(
        '/v1/knowledge/sources/batch-actions',
        {
          method: 'POST',
          idempotencyKey: globalThis.crypto.randomUUID(),
          body: {
            action,
            ids: selectedSourceIds,
            versions,
            ...(action === 'move' ? { targetDirectoryId: batchTarget || null } : {}),
          },
        },
      );
      setBatchResult(result);
      setSelectedSourceIds([]);
      setBatchDeleteOpen(false);
      await Promise.all([sources.refetch(), directories.refetch()]);
    } catch (error) {
      setBatchProblem(error);
    } finally {
      setBatchBusy(false);
    }
  };

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
    await submitWithProblem(async () => {
      await deleteSource.mutateAsync(source.id);
    }, setProblem);
    setDeleteSourceOpen(false);
    setPendingSource(null);
  }

  function openDirectory(directory?: DirectoryRecord) {
    setEditingDirectory(directory ?? null);
    setDirectoryName(directory?.name ?? '');
    setDirectoryParentId(directory?.parentDirectoryId ?? '');
    setDirectoryOpen(true);
  }

  async function submitDirectory() {
    if (!directoryName.trim()) return;
    setDirectoryBusy(true);
    setProblem(null);
    try {
      if (editingDirectory) {
        await knowledgeRequest<DirectoryRecord>(
          `/v1/knowledge/directories/${editingDirectory.id}`,
          {
            method: 'PATCH',
            body: {
              name: directoryName.trim(),
              version: editingDirectory.version,
            },
          },
        );
      } else {
        await knowledgeRequest<DirectoryRecord>(`/v1/knowledge/spaces/${spaceId}/directories`, {
          method: 'POST',
          body: {
            name: directoryName.trim(),
            parentDirectoryId: directoryParentId || null,
          },
        });
      }
      await directories.refetch();
      setDirectoryOpen(false);
    } catch (error) {
      setProblem(error);
    } finally {
      setDirectoryBusy(false);
    }
  }

  async function removeDirectory() {
    if (!pendingDirectory) return;
    setDirectoryBusy(true);
    setProblem(null);
    try {
      await knowledgeRequest<void>(`/v1/knowledge/directories/${pendingDirectory.id}`, {
        method: 'DELETE',
        body: {},
      });
      await Promise.all([directories.refetch(), sources.refetch()]);
      setDeleteDirectoryOpen(false);
      setPendingDirectory(null);
    } catch (error) {
      setProblem(error);
    } finally {
      setDirectoryBusy(false);
    }
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
        actions={
          <>
            <Button onClick={() => openDirectory()}>
              <AddIcon boxSize={3.5} mr={2} />
              {t('directories.create')}
            </Button>
            <Button onClick={() => setSourceOpen(true)}>{t('sources.create')}</Button>
            <Button
              href={`/spaces/${spaceId}/import`}
              tone="primary"
              onClick={() => void router.push(`/spaces/${spaceId}/import`)}
            >
              <DownloadIcon boxSize={4} mr={2} />
              {t('sources.selectFile')}
            </Button>
          </>
        }
      />
      <ProblemNotice
        error={
          space.error ??
          directories.error ??
          sources.error ??
          problem ??
          batchProblem ??
          createSource.error ??
          deleteSource.error
        }
        onRetry={() => void sources.refetch()}
      />
      <Section
        title={t('directories.title')}
        meta={t('directories.meta')}
        actions={
          <Button size="sm" onClick={() => openDirectory()}>
            <AddIcon boxSize={3.5} mr={2} />
            {t('directories.create')}
          </Button>
        }
      >
        <KnowledgeDataTable
          rows={directories.data?.items ?? []}
          rowKey={(directory) => directory.id}
          empty={t('directories.empty')}
          caption={t('directories.title')}
          columns={[
            {
              key: 'name',
              label: t('directories.name'),
              render: (directory) => directory.name,
            },
            {
              key: 'path',
              label: t('spaces.columnPath'),
              render: (directory) =>
                directory.parentPath?.length ? directory.parentPath.length : t('governance.root'),
            },
            {
              key: 'actions',
              label: t('sources.columnActions'),
              render: (directory) => (
                <div className="inline-actions">
                  <Button
                    size="sm"
                    aria-label={t('directories.edit')}
                    onClick={() => openDirectory(directory)}
                  >
                    <EditIcon />
                  </Button>
                  <CatalogMoveControl
                    resourceType="directory"
                    resourceId={directory.id}
                    endpoint={`/v1/knowledge/directories/${directory.id}/move`}
                    version={directory.version}
                    currentParentId={directory.parentDirectoryId}
                    targets={(directories.data?.items ?? [])
                      .filter((entry) => entry.id !== directory.id)
                      .map((entry) => ({
                        id: entry.id,
                        label: entry.name,
                      }))}
                    onMoved={async () => {
                      await Promise.all([directories.refetch(), sources.refetch()]);
                    }}
                  />
                  <Button
                    size="sm"
                    tone="danger"
                    aria-label={t('directories.delete')}
                    onClick={() => {
                      setPendingDirectory(directory);
                      setDeleteDirectoryOpen(true);
                    }}
                  >
                    <DeleteIcon />
                  </Button>
                </div>
              ),
            },
          ]}
        />
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
          <SelectInput
            aria-label={t('governance.moveTarget')}
            value={batchTarget}
            onChange={(event) => setBatchTarget(event.target.value)}
            maxW="220px"
          >
            <option value="">{t('directories.root')}</option>
            {directories.data?.items.map((directory) => (
              <option key={directory.id} value={directory.id}>
                {directory.name}
              </option>
            ))}
          </SelectInput>
          <Button
            size="sm"
            busy={batchBusy}
            isDisabled={selectedSourceIds.length === 0}
            onClick={() => void runSourceBatch('move')}
          >
            {t('sources.batchMove')}
          </Button>
          <Button
            size="sm"
            tone="danger"
            busy={batchBusy}
            isDisabled={selectedSourceIds.length === 0}
            onClick={() => setBatchDeleteOpen(true)}
          >
            {t('sources.batchDelete')}
          </Button>
          <span>{t('sources.selectedCount', { count: selectedSourceIds.length })}</span>
        </div>
        <CatalogBatchResult result={batchResult} />
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
                    <CatalogMoveControl
                      resourceType="source"
                      resourceId={source.id}
                      endpoint={`/v1/knowledge/sources/${source.id}/move`}
                      version={source.version}
                      currentParentId={source.directoryId}
                      targets={(directories.data?.items ?? []).map((directory) => ({
                        id: directory.id,
                        label: directory.name,
                      }))}
                      onMoved={async () => {
                        await Promise.all([sources.refetch(), directories.refetch()]);
                      }}
                    />
                    <Button href={`/spaces/${spaceId}/segments?sourceId=${source.id}`} size="sm">
                      {t('sources.actionSegments')}
                    </Button>
                    <Button
                      size="sm"
                      tone="danger"
                      busy={deleteSource.isLoading}
                      onClick={() => {
                        setPendingSource(source);
                        setDeleteSourceOpen(true);
                      }}
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

      <FormDrawer
        isOpen={sourceOpen}
        onClose={() => setSourceOpen(false)}
        title={t('sources.createTitle')}
        description={t('sources.formDescription')}
        footer={
          <>
            <Button onClick={() => setSourceOpen(false)}>{t('common.cancel')}</Button>
            <Button
              type="submit"
              form="source-create-form"
              tone="primary"
              busy={createSource.isLoading}
            >
              {t('sources.create')}
            </Button>
          </>
        }
      >
        <form id="source-create-form" className="form-stack" onSubmit={submitSource}>
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
        </form>
      </FormDrawer>

      <FormDrawer
        isOpen={directoryOpen}
        onClose={() => setDirectoryOpen(false)}
        title={editingDirectory ? t('directories.editTitle') : t('directories.createTitle')}
        description={
          editingDirectory ? t('directories.editDescription') : t('directories.createDescription')
        }
        footer={
          <>
            <Button onClick={() => setDirectoryOpen(false)}>{t('common.cancel')}</Button>
            <Button tone="primary" busy={directoryBusy} onClick={() => void submitDirectory()}>
              {editingDirectory ? t('common.save') : t('directories.create')}
            </Button>
          </>
        }
      >
        <div className="form-stack">
          <label className="field">
            <span className="field-label">{t('directories.name')}</span>
            <TextInput
              value={directoryName}
              maxLength={120}
              onChange={(event) => setDirectoryName(event.target.value)}
            />
          </label>
          {!editingDirectory ? (
            <label className="field">
              <span className="field-label">{t('directories.parent')}</span>
              <SelectInput
                value={directoryParentId}
                onChange={(event) => setDirectoryParentId(event.target.value)}
              >
                <option value="">{t('directories.root')}</option>
                {directories.data?.items.map((directory) => (
                  <option key={directory.id} value={directory.id}>
                    {directory.name}
                  </option>
                ))}
              </SelectInput>
            </label>
          ) : null}
        </div>
      </FormDrawer>

      <ConfirmDialog
        isOpen={deleteSourceOpen}
        onClose={() => setDeleteSourceOpen(false)}
        onConfirm={async () => {
          if (pendingSource) await removeSource(pendingSource);
        }}
        title={t('sources.deleteTitle')}
        description={pendingSource ? t('sources.confirmDelete', { name: pendingSource.name }) : ''}
        confirmLabel={t('sources.actionDelete')}
        busy={deleteSource.isLoading}
        destructive
      />

      <ConfirmDialog
        isOpen={batchDeleteOpen}
        onClose={() => setBatchDeleteOpen(false)}
        onConfirm={() => runSourceBatch('delete')}
        title={t('sources.batchDeleteTitle')}
        description={t('sources.confirmBatchDelete', { count: selectedSourceIds.length })}
        confirmLabel={t('sources.batchDelete')}
        busy={batchBusy}
        destructive
      />

      <ConfirmDialog
        isOpen={deleteDirectoryOpen}
        onClose={() => setDeleteDirectoryOpen(false)}
        onConfirm={() => void removeDirectory()}
        title={t('directories.deleteTitle')}
        description={
          pendingDirectory ? t('directories.confirmDelete', { name: pendingDirectory.name }) : ''
        }
        confirmLabel={t('directories.delete')}
        busy={directoryBusy}
        destructive
      />
    </>
  );
}
