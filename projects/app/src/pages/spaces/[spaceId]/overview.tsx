import {
  Button,
  FormField,
  LoadingState,
  PageHeader,
  ProblemNotice,
  S5ModelBindingPanel,
  Section,
  SpaceExportAction,
  SpaceReferencesPanel,
  StatusTag,
  TextArea,
  TextInput,
  formatDate,
  knowledgeQueryKeys,
  knowledgeRequest,
  submitWithProblem,
  updateSpaceFormSchema,
  useKnowledgeEnumLabel,
  useKnowledgeForm,
  useKnowledgeI18n,
  useKnowledgeMutation,
  useKnowledgeModelCatalog,
  useKnowledgeQuery,
  type UpdateSpaceFormValues,
  type S5ModelBindingView,
  type S5ModelValidationView,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useState } from 'react';
import type { DirectoryRecord, SourceRecord, SpaceRecord } from '../../../lib/knowledge-types';
import { listPath, statusTone } from '../../../lib/knowledge-types';

export default function SpaceOverviewPage() {
  const router = useRouter();
  const { locale, t } = useKnowledgeI18n();
  const enumLabel = useKnowledgeEnumLabel();
  const spaceId = typeof router.query.spaceId === 'string' ? router.query.spaceId : '';
  const [problem, setProblem] = useState<unknown>(null);
  const spaceRequest = useKnowledgeQuery<SpaceRecord>(
    knowledgeQueryKeys.spaces.detail(spaceId),
    spaceId ? `/v1/knowledge/spaces/${spaceId}` : null,
  );
  const directoriesRequest = useKnowledgeQuery<{ items: DirectoryRecord[] }>(
    knowledgeQueryKeys.directories.list(spaceId),
    spaceId ? listPath(spaceId, 'directories') : null,
  );
  const sourcesRequest = useKnowledgeQuery<{ items: SourceRecord[] }>(
    knowledgeQueryKeys.sources.list(spaceId),
    spaceId ? listPath(spaceId, 'sources') : null,
  );
  const modelsRequest = useKnowledgeModelCatalog();
  const bindingsRequest = useKnowledgeQuery<{ items: S5ModelBindingView[] }>(
    knowledgeQueryKeys.modelBindings.detail(spaceId),
    spaceId ? `/v1/knowledge/spaces/${spaceId}/model-bindings` : null,
  );
  const form = useKnowledgeForm(updateSpaceFormSchema, {
    defaultValues: { name: '', description: '' },
  });
  const space = spaceRequest.data;
  const updateSpace = useKnowledgeMutation<SpaceRecord, UpdateSpaceFormValues>({
    mutationFn: (values) =>
      knowledgeRequest<SpaceRecord>(`/v1/knowledge/spaces/${space!.id}`, {
        method: 'PATCH',
        body: {
          version: space!.version,
          name: values.name || space!.name,
          description: values.description || space!.description,
        },
      }),
    invalidateKeys: [
      knowledgeQueryKeys.spaces.list({ limit: 200 }),
      knowledgeQueryKeys.spaces.detail(spaceId),
    ],
    onSuccess: () => {
      form.reset({ name: '', description: '' });
    },
  });
  const deleteSpace = useKnowledgeMutation<void, void>({
    mutationFn: () =>
      knowledgeRequest<void>(`/v1/knowledge/spaces/${space!.id}`, {
        method: 'DELETE',
        body: {
          version: space!.version,
          expectedReferenceRevision: space!.referenceRevision,
          referenceStrategy: 'block',
        },
      }),
    invalidateKeys: [
      knowledgeQueryKeys.spaces.list({ limit: 200 }),
      knowledgeQueryKeys.spaces.detail(spaceId),
      knowledgeQueryKeys.jobs.list(),
    ],
    onSuccess: async () => {
      await router.push('/spaces');
    },
  });
  const updateBindings = useKnowledgeMutation<
    { items: S5ModelBindingView[]; version?: number },
    { bindings: S5ModelBindingView[]; version: number }
  >({
    mutationFn: (input) =>
      knowledgeRequest(`/v1/knowledge/spaces/${spaceId}/model-bindings`, {
        method: 'PUT',
        body: input,
      }),
    invalidateKeys: [
      knowledgeQueryKeys.modelBindings.detail(spaceId),
      knowledgeQueryKeys.spaces.detail(spaceId),
    ],
  });

  const submitUpdate = form.handleSubmit(async (values) => {
    await submitWithProblem(
      async () => {
        await updateSpace.mutateAsync(values);
      },
      setProblem,
      form,
    );
  });

  async function removeSpace() {
    if (!space) return;
    if (!window.confirm(t('overview.confirmDelete', { name: space.name }))) return;
    await submitWithProblem(async () => {
      await deleteSpace.mutateAsync();
    }, setProblem);
  }

  const validateBinding = (binding: S5ModelBindingView) =>
    knowledgeRequest<S5ModelValidationView>('/v1/knowledge/model-bindings/validate', {
      method: 'POST',
      body: {
        modelId: binding.modelId,
        modelType: binding.modelType,
        requiredCapabilities: binding.requiredCapabilities,
      },
    });

  return (
    <>
      <Head>
        <title>
          {space ? t('overview.title', { name: space.name }) : t('overview.fallbackTitle')}
        </title>
      </Head>
      <PageHeader
        eyebrow={t('overview.eyebrow')}
        title={space?.name ?? t('overview.fallbackHeading')}
        description={space?.description || t('overview.description')}
        actions={
          space ? (
            <>
              <Button href={`/spaces/${space.id}/sources`}>{t('overview.sources')}</Button>
              <Button tone="danger" onClick={() => void removeSpace()} busy={deleteSpace.isLoading}>
                {t('overview.delete')}
              </Button>
            </>
          ) : null
        }
      />
      <ProblemNotice
        error={
          spaceRequest.error ??
          directoriesRequest.error ??
          sourcesRequest.error ??
          modelsRequest.error ??
          bindingsRequest.error ??
          problem ??
          updateSpace.error ??
          deleteSpace.error
        }
        onRetry={() => void spaceRequest.refetch()}
      />
      {spaceRequest.isLoading || !space ? (
        <LoadingState />
      ) : (
        <>
          <div className="metric-strip">
            <div className="metric">
              <span>{t('overview.metricDirectories')}</span>
              <strong>{directoriesRequest.data?.items.length ?? 0}</strong>
            </div>
            <div className="metric">
              <span>{t('overview.metricSources')}</span>
              <strong>{sourcesRequest.data?.items.length ?? 0}</strong>
            </div>
            <div className="metric">
              <span>{t('overview.metricReferenceRevision')}</span>
              <strong>{space.referenceRevision}</strong>
            </div>
            <div className="metric">
              <span>{t('overview.metricVersion')}</span>
              <strong>{space.version}</strong>
            </div>
          </div>

          <Section title={t('overview.configuration')}>
            <div className="detail-grid">
              <div className="detail-cell">
                <span>{t('overview.type')}</span>
                <strong>{enumLabel(space.kind)}</strong>
              </div>
              <div className="detail-cell">
                <span>{t('overview.status')}</span>
                <strong>
                  <StatusTag value={space.status} tone={statusTone(space.status)} />
                </strong>
              </div>
              <div className="detail-cell">
                <span>{t('overview.accessMode')}</span>
                <strong>{enumLabel(space.accessMode)}</strong>
              </div>
              <div className="detail-cell">
                <span>{t('overview.sourceAclMode')}</span>
                <strong>{enumLabel(space.sourceAclMode)}</strong>
              </div>
              <div className="detail-cell">
                <span>{t('overview.owner')}</span>
                <strong className="mono">{space.ownershipMemberId}</strong>
              </div>
              <div className="detail-cell">
                <span>{t('overview.updated')}</span>
                <strong>{formatDate(space.updatedAt, locale)}</strong>
              </div>
            </div>
          </Section>

          <Section title={t('models.title')}>
            {modelsRequest.isLoading || bindingsRequest.isLoading ? (
              <LoadingState label={t('models.loading')} />
            ) : (
              <S5ModelBindingPanel
                models={modelsRequest.data?.items ?? []}
                bindings={bindingsRequest.data?.items ?? []}
                spaceVersion={space.version}
                onValidate={validateBinding}
                onSave={(input) => updateBindings.mutateAsync(input).then(() => undefined)}
                labels={{
                  title: t('models.title'),
                  validate: t('models.validate'),
                  save: t('models.save'),
                  noModels: t('models.noModels'),
                  capabilities: t('models.capabilities'),
                  disabled: t('models.disabled'),
                }}
                messageFor={(entry) => t(entry.messageKey, entry.params)}
              />
            )}
          </Section>

          <Section title={t('overview.updateTitle')} meta={t('overview.updateMeta')}>
            <form className="form-band" onSubmit={submitUpdate}>
              <div className="form-intro">
                <h2>{t('overview.updateFormTitle')}</h2>
                <p>{t('overview.updateFormDescription')}</p>
              </div>
              <div className="form-fields">
                <FormField
                  control={form.control}
                  name="name"
                  label={t('newSpace.name')}
                  render={(field) => (
                    <TextInput
                      {...field}
                      maxLength={120}
                      placeholder={space.name}
                      value={String(field.value)}
                      onChange={(event) => field.onChange(event.target.value)}
                    />
                  )}
                />
                <FormField
                  control={form.control}
                  name="description"
                  label={t('newSpace.fieldDescription')}
                  render={(field) => (
                    <TextArea
                      {...field}
                      maxLength={2000}
                      placeholder={space.description}
                      value={String(field.value)}
                      onChange={(event) => field.onChange(event.target.value)}
                    />
                  )}
                />
              </div>
              <div className="form-actions">
                <Button type="submit" tone="primary" busy={updateSpace.isLoading}>
                  {t('overview.save')}
                </Button>
              </div>
            </form>
          </Section>
          <Section title={t('governance.exportSpace')}>
            <SpaceExportAction spaceId={space.id} />
          </Section>
          <Section title={t('governance.references')}>
            <SpaceReferencesPanel spaceId={space.id} />
          </Section>
        </>
      )}
    </>
  );
}
