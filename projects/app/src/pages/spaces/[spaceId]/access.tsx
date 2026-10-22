import {
  Button,
  DataTable,
  Field,
  LoadingState,
  PageHeader,
  ProblemNotice,
  Section,
  SelectInput,
  StatusTag,
  TextInput,
  knowledgeRequest,
  useKnowledgeRequest,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useState, type FormEvent } from 'react';
import type {
  AclRecord,
  CollaboratorRecord,
  SourceRecord,
  SpaceRecord,
} from '../../../lib/knowledge-types';
import { listPath, statusTone } from '../../../lib/knowledge-types';

export default function AccessPage() {
  const router = useRouter();
  const spaceId = typeof router.query.spaceId === 'string' ? router.query.spaceId : '';
  const space = useKnowledgeRequest<SpaceRecord>(
    spaceId ? `/v1/knowledge/spaces/${spaceId}` : null,
    [spaceId],
  );
  const spaceAcl = useKnowledgeRequest<AclRecord>(
    spaceId ? `/v1/knowledge/resources/space/${spaceId}/acl` : null,
    [spaceId],
  );
  const collaborators = useKnowledgeRequest<{ items: CollaboratorRecord[] }>(
    spaceId ? `/v1/knowledge/spaces/${spaceId}/collaborators?limit=200` : null,
    [spaceId],
  );
  const sources = useKnowledgeRequest<{ items: SourceRecord[] }>(
    spaceId ? listPath(spaceId, 'sources') : null,
    [spaceId],
  );
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const source = sources.data?.items.find((item) => item.id === selectedSourceId);
  const sourceAcl = useKnowledgeRequest<AclRecord>(
    selectedSourceId ? `/v1/knowledge/resources/source/${selectedSourceId}/acl` : null,
    [selectedSourceId],
  );
  const [memberId, setMemberId] = useState('');
  const [role, setRole] = useState<'read' | 'write' | 'manage'>('read');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!selectedSourceId && sources.data?.items[0]) {
      setSelectedSourceId(sources.data.items[0].id);
    }
  }, [selectedSourceId, sources.data]);

  async function addCollaborator(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!spaceId) return;
    setBusy(true);
    setError(null);
    try {
      await knowledgeRequest(`/v1/knowledge/spaces/${spaceId}/collaborators`, {
        method: 'POST',
        body: { memberId, role },
      });
      setMemberId('');
      await Promise.all([collaborators.reload(), spaceAcl.reload(), space.reload()]);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function updateCollaborator(collaborator: CollaboratorRecord) {
    if (!spaceId) return;
    setBusy(true);
    setError(null);
    try {
      await knowledgeRequest(
        `/v1/knowledge/spaces/${spaceId}/collaborators/${collaborator.memberId}`,
        {
          method: 'PATCH',
          body: {
            version: collaborator.version,
            role: collaborator.role === 'read' ? 'write' : 'read',
          },
        },
      );
      await Promise.all([collaborators.reload(), spaceAcl.reload()]);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function removeCollaborator(collaborator: CollaboratorRecord) {
    if (!spaceId) return;
    if (!window.confirm(`Remove ${collaborator.memberId} from this space?`)) return;
    setBusy(true);
    setError(null);
    try {
      await knowledgeRequest(
        `/v1/knowledge/spaces/${spaceId}/collaborators/${collaborator.memberId}`,
        { method: 'DELETE' },
      );
      await Promise.all([collaborators.reload(), spaceAcl.reload()]);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function transitionPermission(action: 'enable' | 'disable' | 'detach' | 'resume') {
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      await knowledgeRequest(`/v1/knowledge/sources/${source.id}/permissions/${action}`, {
        method: 'POST',
        body: {
          version: source.version,
          expectedPermissionRevision: source.permissionRevision,
        },
      });
      await Promise.all([sources.reload(), sourceAcl.reload()]);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Head>
        <title>{space.data ? `${space.data.name} access` : 'Access'}</title>
      </Head>
      <PageHeader
        eyebrow="Access governance"
        title="Access"
        description="Workspace membership, collaborators, ACL snapshots and Source permission state."
      />
      <ProblemNotice
        error={
          space.error ??
          spaceAcl.error ??
          collaborators.error ??
          sources.error ??
          sourceAcl.error ??
          error
        }
      />
      <Section
        title="Space ACL"
        meta={spaceAcl.data ? `revision ${spaceAcl.data.permissionRevision}` : undefined}
      >
        {spaceAcl.loading ? (
          <LoadingState />
        ) : (
          <DataTable
            rows={spaceAcl.data?.entries ?? []}
            rowKey={(entry) => `${entry.principalType}:${entry.principalId}`}
            empty="No ACL entries are visible."
            columns={[
              { key: 'type', label: 'Principal type', render: (entry) => entry.principalType },
              {
                key: 'principal',
                label: 'Principal',
                render: (entry) => <span className="mono">{entry.principalId}</span>,
              },
              { key: 'permission', label: 'Permission', render: (entry) => entry.permission },
            ]}
          />
        )}
      </Section>

      <Section
        title="Collaborators"
        meta={collaborators.data ? `${collaborators.data.items.length} active` : undefined}
      >
        <form className="form-band" onSubmit={addCollaborator}>
          <div className="form-intro">
            <h2>Add collaborator</h2>
            <p>Collaborator roles are scoped to this Knowledge Space.</p>
          </div>
          <div className="form-fields">
            <Field label="Member ID">
              <TextInput
                required
                value={memberId}
                onChange={(event) => setMemberId(event.target.value)}
              />
            </Field>
            <Field label="Role">
              <SelectInput
                value={role}
                onChange={(event) => setRole(event.target.value as typeof role)}
              >
                <option value="read">Read</option>
                <option value="write">Write</option>
                <option value="manage">Manage</option>
              </SelectInput>
            </Field>
          </div>
          <div className="form-actions">
            <Button type="submit" tone="primary" busy={busy}>
              Add collaborator
            </Button>
          </div>
        </form>
        <DataTable
          rows={collaborators.data?.items ?? []}
          rowKey={(collaborator) => collaborator.memberId}
          empty="No collaborators."
          columns={[
            {
              key: 'member',
              label: 'Member',
              render: (collaborator) => <span className="mono">{collaborator.memberId}</span>,
            },
            { key: 'role', label: 'Role', render: (collaborator) => collaborator.role },
            {
              key: 'status',
              label: 'Status',
              render: (collaborator) => (
                <StatusTag value={collaborator.status} tone={statusTone(collaborator.status)} />
              ),
            },
            {
              key: 'actions',
              label: 'Actions',
              render: (collaborator) => (
                <div className="inline-actions">
                  <Button
                    className="button-small"
                    busy={busy}
                    onClick={() => void updateCollaborator(collaborator)}
                  >
                    Toggle role
                  </Button>
                  <Button
                    className="button-small"
                    tone="danger"
                    busy={busy}
                    onClick={() => void removeCollaborator(collaborator)}
                  >
                    Remove
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </Section>

      <Section title="Source permission state">
        <div className="selector-row">
          <Field label="Source">
            <SelectInput
              value={selectedSourceId}
              onChange={(event) => setSelectedSourceId(event.target.value)}
            >
              <option value="">Select Source</option>
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
                busy={busy}
                disabled={source.permissionState !== 'disabled'}
                onClick={() => void transitionPermission('enable')}
              >
                Enable inheritance
              </Button>
              <Button
                busy={busy}
                disabled={source.permissionState !== 'inherited'}
                onClick={() => void transitionPermission('detach')}
              >
                Detach
              </Button>
              <Button
                busy={busy}
                disabled={source.permissionState !== 'independent'}
                onClick={() => void transitionPermission('resume')}
              >
                Resume inheritance
              </Button>
              <Button
                tone="danger"
                busy={busy}
                disabled={source.permissionState === 'disabled'}
                onClick={() => void transitionPermission('disable')}
              >
                Disable
              </Button>
            </div>
            <div className="detail-grid" style={{ marginTop: 18 }}>
              <div className="detail-cell">
                <span>Permission revision</span>
                <strong>{source.permissionRevision}</strong>
              </div>
              <div className="detail-cell">
                <span>State</span>
                <strong>{source.permissionState}</strong>
              </div>
              <div className="detail-cell">
                <span>Snapshot</span>
                <strong>{sourceAcl.data?.snapshotVersion ?? '-'}</strong>
              </div>
            </div>
          </>
        ) : (
          <p className="table-empty">Select a Source to inspect permission state.</p>
        )}
      </Section>
    </>
  );
}
