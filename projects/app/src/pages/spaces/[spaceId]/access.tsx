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
  TextInput,
  collaboratorFormSchema,
  knowledgeQueryKeys,
  knowledgeRequest,
  submitWithProblem,
  useKnowledgeEnumLabel,
  useKnowledgeForm,
  useKnowledgeI18n,
  useKnowledgeMutation,
  useKnowledgeQuery,
  type CollaboratorFormValues,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import type {
  AclRecord,
  CollaboratorRecord,
  SourceRecord,
  SpaceRecord,
} from '../../../lib/knowledge-types';
import { listPath, statusTone } from '../../../lib/knowledge-types';

type PermissionAction = 'enable' | 'disable' | 'detach' | 'resume';

export default function AccessPage() {
  const router = useRouter();
  const { t } = useKnowledgeI18n();
  const enumLabel = useKnowledgeEnumLabel();
  const spaceId = typeof router.query.spaceId === 'string' ? router.query.spaceId : '';
  const [problem, setProblem] = useState<unknown>(null);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const space = useKnowledgeQuery<SpaceRecord>(
    knowledgeQueryKeys.spaces.detail(spaceId),
    spaceId ? `/v1/knowledge/spaces/${spaceId}` : null,
  );
  const spaceAcl = useKnowledgeQuery<AclRecord>(
    knowledgeQueryKeys.acl('space', spaceId),
    spaceId ? `/v1/knowledge/resources/space/${spaceId}/acl` : null,
  );
  const collaborators = useKnowledgeQuery<{ items: CollaboratorRecord[] }>(
    knowledgeQueryKeys.collaborators.list(spaceId),
    spaceId ? `/v1/knowledge/spaces/${spaceId}/collaborators?limit=200` : null,
  );
  const sources = useKnowledgeQuery<{ items: SourceRecord[] }>(
    knowledgeQueryKeys.sources.list(spaceId),
    spaceId ? listPath(spaceId, 'sources') : null,
  );
  const source = sources.data?.items.find((item) => item.id === selectedSourceId);
  const sourceAcl = useKnowledgeQuery<AclRecord>(
    knowledgeQueryKeys.acl('source', selectedSourceId),
    selectedSourceId ? `/v1/knowledge/resources/source/${selectedSourceId}/acl` : null,
  );
  const collaboratorForm = useKnowledgeForm(collaboratorFormSchema, {
    defaultValues: { memberId: '', role: 'read' },
  });
  const addCollaborator = useKnowledgeMutation<CollaboratorRecord, CollaboratorFormValues>({
    mutationFn: (values) =>
      knowledgeRequest<CollaboratorRecord>(`/v1/knowledge/spaces/${spaceId}/collaborators`, {
        method: 'POST',
        body: values,
      }),
    invalidateKeys: [
      knowledgeQueryKeys.collaborators.list(spaceId),
      knowledgeQueryKeys.acl('space', spaceId),
      knowledgeQueryKeys.spaces.detail(spaceId),
    ],
    onSuccess: () => {
      collaboratorForm.reset();
    },
  });
  const updateCollaborator = useKnowledgeMutation<CollaboratorRecord, CollaboratorRecord>({
    mutationFn: (collaborator) =>
      knowledgeRequest<CollaboratorRecord>(
        `/v1/knowledge/spaces/${spaceId}/collaborators/${collaborator.memberId}`,
        {
          method: 'PATCH',
          body: {
            version: collaborator.version,
            role: collaborator.role === 'read' ? 'write' : 'read',
          },
        },
      ),
    invalidateKeys: [
      knowledgeQueryKeys.collaborators.list(spaceId),
      knowledgeQueryKeys.acl('space', spaceId),
    ],
  });
  const removeCollaborator = useKnowledgeMutation<void, string>({
    mutationFn: (memberId) =>
      knowledgeRequest<void>(`/v1/knowledge/spaces/${spaceId}/collaborators/${memberId}`, {
        method: 'DELETE',
      }),
    invalidateKeys: [
      knowledgeQueryKeys.collaborators.list(spaceId),
      knowledgeQueryKeys.acl('space', spaceId),
    ],
  });
  const transitionPermission = useKnowledgeMutation<void, PermissionAction>({
    mutationFn: (action) =>
      knowledgeRequest<void>(`/v1/knowledge/sources/${source!.id}/permissions/${action}`, {
        method: 'POST',
        body: {
          version: source!.version,
          expectedPermissionRevision: source!.permissionRevision,
        },
      }),
    invalidateKeys: [
      knowledgeQueryKeys.sources.list(spaceId),
      knowledgeQueryKeys.acl('source', selectedSourceId),
      knowledgeQueryKeys.jobs.list(),
    ],
  });

  useEffect(() => {
    if (!selectedSourceId && sources.data?.items[0]) {
      setSelectedSourceId(sources.data.items[0].id);
    }
  }, [selectedSourceId, sources.data]);

  const submitCollaborator = collaboratorForm.handleSubmit(async (values) => {
    await submitWithProblem(
      async () => {
        await addCollaborator.mutateAsync(values);
      },
      setProblem,
      collaboratorForm,
    );
  });

  async function changeCollaborator(collaborator: CollaboratorRecord) {
    await submitWithProblem(async () => {
      await updateCollaborator.mutateAsync(collaborator);
    }, setProblem);
  }

  async function revokeCollaborator(collaborator: CollaboratorRecord) {
    if (!window.confirm(t('access.confirmRemove', { memberId: collaborator.memberId }))) return;
    await submitWithProblem(async () => {
      await removeCollaborator.mutateAsync(collaborator.memberId);
    }, setProblem);
  }

  async function changePermission(action: PermissionAction) {
    await submitWithProblem(async () => {
      await transitionPermission.mutateAsync(action);
    }, setProblem);
  }

  return (
    <>
      <Head>
        <title>
          {space.data ? t('access.title', { name: space.data.name }) : t('access.fallbackTitle')}
        </title>
      </Head>
      <PageHeader
        eyebrow={t('access.eyebrow')}
        title={t('access.heading')}
        description={t('access.description')}
      />
      <ProblemNotice
        error={
          space.error ??
          spaceAcl.error ??
          collaborators.error ??
          sources.error ??
          sourceAcl.error ??
          problem ??
          addCollaborator.error ??
          updateCollaborator.error ??
          removeCollaborator.error ??
          transitionPermission.error
        }
        onRetry={() => void collaborators.refetch()}
      />
      <Section
        title={t('access.spaceAcl')}
        meta={
          spaceAcl.data
            ? t('access.revision', { revision: spaceAcl.data.permissionRevision })
            : undefined
        }
      >
        {spaceAcl.isLoading ? (
          <LoadingState />
        ) : (
          <KnowledgeDataTable
            rows={spaceAcl.data?.entries ?? []}
            rowKey={(entry) => `${entry.principalType}:${entry.principalId}`}
            empty={t('access.noAcl')}
            caption={t('access.spaceAcl')}
            columns={[
              {
                key: 'type',
                label: t('access.columnPrincipalType'),
                render: (entry) => enumLabel(entry.principalType),
              },
              {
                key: 'principal',
                label: t('access.columnPrincipal'),
                render: (entry) => <span className="mono">{entry.principalId}</span>,
              },
              {
                key: 'permission',
                label: t('access.columnPermission'),
                render: (entry) => enumLabel(entry.permission),
              },
            ]}
          />
        )}
      </Section>

      <Section
        title={t('access.collaborators')}
        meta={
          collaborators.data
            ? t('access.activeCount', { count: collaborators.data.items.length })
            : undefined
        }
      >
        <form className="form-band" onSubmit={submitCollaborator}>
          <div className="form-intro">
            <h2>{t('access.addTitle')}</h2>
            <p>{t('access.addDescription')}</p>
          </div>
          <div className="form-fields">
            <FormField
              control={collaboratorForm.control}
              name="memberId"
              label={t('access.memberId')}
              render={(field) => (
                <TextInput
                  {...field}
                  required
                  value={String(field.value)}
                  onChange={(event) => field.onChange(event.target.value)}
                />
              )}
            />
            <FormField
              control={collaboratorForm.control}
              name="role"
              label={t('access.role')}
              render={(field) => (
                <SelectInput
                  name={field.name}
                  value={String(field.value)}
                  onBlur={field.onBlur}
                  onChange={(event) => field.onChange(event.target.value)}
                >
                  <option value="read">{t('enum.read')}</option>
                  <option value="write">{t('enum.write')}</option>
                  <option value="manage">{t('enum.manage')}</option>
                </SelectInput>
              )}
            />
          </div>
          <div className="form-actions">
            <Button type="submit" tone="primary" busy={addCollaborator.isLoading}>
              {t('access.add')}
            </Button>
          </div>
        </form>
        <KnowledgeDataTable
          rows={collaborators.data?.items ?? []}
          rowKey={(collaborator) => collaborator.memberId}
          empty={t('access.noCollaborators')}
          caption={t('access.collaborators')}
          columns={[
            {
              key: 'member',
              label: t('access.columnMember'),
              render: (collaborator) => <span className="mono">{collaborator.memberId}</span>,
            },
            {
              key: 'role',
              label: t('access.role'),
              render: (collaborator) => enumLabel(collaborator.role),
            },
            {
              key: 'status',
              label: t('access.columnStatus'),
              render: (collaborator) => (
                <StatusTag value={collaborator.status} tone={statusTone(collaborator.status)} />
              ),
            },
            {
              key: 'actions',
              label: t('access.columnActions'),
              render: (collaborator) => (
                <div className="inline-actions">
                  <Button
                    size="sm"
                    busy={updateCollaborator.isLoading}
                    onClick={() => void changeCollaborator(collaborator)}
                  >
                    {t('access.toggleRole')}
                  </Button>
                  <Button
                    size="sm"
                    tone="danger"
                    busy={removeCollaborator.isLoading}
                    onClick={() => void revokeCollaborator(collaborator)}
                  >
                    {t('access.remove')}
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </Section>

      <Section title={t('access.sourcePermissionState')}>
        <div className="selector-row">
          <Field label={t('access.source')}>
            <SelectInput
              value={selectedSourceId}
              onChange={(event) => setSelectedSourceId(event.target.value)}
            >
              <option value="">{t('access.selectSource')}</option>
              {sources.data?.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </SelectInput>
          </Field>
          {source ? (
            <StatusTag value={source.permissionState} tone={statusTone(source.permissionState)} />
          ) : null}
        </div>
        {source ? (
          <>
            <div className="inline-actions">
              <Button
                busy={transitionPermission.isLoading}
                disabled={source.permissionState !== 'disabled'}
                onClick={() => void changePermission('enable')}
              >
                {t('access.enableInheritance')}
              </Button>
              <Button
                busy={transitionPermission.isLoading}
                disabled={source.permissionState !== 'inherited'}
                onClick={() => void changePermission('detach')}
              >
                {t('access.detach')}
              </Button>
              <Button
                busy={transitionPermission.isLoading}
                disabled={source.permissionState !== 'independent'}
                onClick={() => void changePermission('resume')}
              >
                {t('access.resumeInheritance')}
              </Button>
              <Button
                tone="danger"
                busy={transitionPermission.isLoading}
                disabled={source.permissionState === 'disabled'}
                onClick={() => void changePermission('disable')}
              >
                {t('access.disable')}
              </Button>
            </div>
            <div className="detail-grid detail-grid-spaced">
              <div className="detail-cell">
                <span>{t('access.permissionRevision')}</span>
                <strong>{source.permissionRevision}</strong>
              </div>
              <div className="detail-cell">
                <span>{t('access.state')}</span>
                <strong>{enumLabel(source.permissionState)}</strong>
              </div>
              <div className="detail-cell">
                <span>{t('access.snapshot')}</span>
                <strong>{sourceAcl.data?.snapshotVersion ?? '-'}</strong>
              </div>
            </div>
          </>
        ) : (
          <p className="table-empty">{t('access.selectSourcePrompt')}</p>
        )}
      </Section>
    </>
  );
}
