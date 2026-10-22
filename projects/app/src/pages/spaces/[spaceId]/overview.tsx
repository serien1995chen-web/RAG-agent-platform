import {
  Button,
  Field,
  LoadingState,
  PageHeader,
  ProblemNotice,
  Section,
  StatusTag,
  TextArea,
  TextInput,
  formatDate,
  knowledgeRequest,
  useKnowledgeRequest,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useState, type FormEvent } from 'react';
import type { DirectoryRecord, SourceRecord, SpaceRecord } from '../../../lib/knowledge-types';
import { listPath, statusTone } from '../../../lib/knowledge-types';

export default function SpaceOverviewPage() {
  const router = useRouter();
  const spaceId = typeof router.query.spaceId === 'string' ? router.query.spaceId : '';
  const spaceRequest = useKnowledgeRequest<SpaceRecord>(
    spaceId ? `/v1/knowledge/spaces/${spaceId}` : null,
    [spaceId],
  );
  const directoriesRequest = useKnowledgeRequest<{ items: DirectoryRecord[] }>(
    spaceId ? listPath(spaceId, 'directories') : null,
    [spaceId],
  );
  const sourcesRequest = useKnowledgeRequest<{ items: SourceRecord[] }>(
    spaceId ? listPath(spaceId, 'sources') : null,
    [spaceId],
  );
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const space = spaceRequest.data;

  async function updateSpace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!space) return;
    setBusy(true);
    setError(null);
    try {
      await knowledgeRequest(`/v1/knowledge/spaces/${space.id}`, {
        method: 'PATCH',
        body: {
          version: space.version,
          name: name || space.name,
          description: description || space.description,
        },
      });
      await spaceRequest.reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function deleteSpace() {
    if (!space) return;
    if (!window.confirm(`Delete ${space.name}? This creates an asynchronous delete job.`)) return;
    setBusy(true);
    setError(null);
    try {
      await knowledgeRequest(`/v1/knowledge/spaces/${space.id}`, {
        method: 'DELETE',
        body: {
          version: space.version,
          expectedReferenceRevision: space.referenceRevision,
          referenceStrategy: 'block',
        },
      });
      await router.push('/spaces');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Head>
        <title>{space?.name ?? 'Space overview'}</title>
      </Head>
      <PageHeader
        eyebrow="Space overview"
        title={space?.name ?? 'Space'}
        description={space?.description || 'Knowledge Space metadata and baseline status.'}
        actions={
          space ? (
            <>
              <a className="button" href={`/spaces/${space.id}/sources`}>
                Sources
              </a>
              <Button tone="danger" onClick={deleteSpace} busy={busy}>
                Delete space
              </Button>
            </>
          ) : null
        }
      />
      <ProblemNotice
        error={spaceRequest.error ?? directoriesRequest.error ?? sourcesRequest.error ?? error}
      />
      {spaceRequest.loading || !space ? (
        <LoadingState />
      ) : (
        <>
          <div className="metric-strip">
            <div className="metric">
              <span>Directories</span>
              <strong>{directoriesRequest.data?.items.length ?? 0}</strong>
            </div>
            <div className="metric">
              <span>Sources</span>
              <strong>{sourcesRequest.data?.items.length ?? 0}</strong>
            </div>
            <div className="metric">
              <span>Reference revision</span>
              <strong>{space.referenceRevision}</strong>
            </div>
            <div className="metric">
              <span>Version</span>
              <strong>{space.version}</strong>
            </div>
          </div>

          <Section title="Configuration">
            <div className="detail-grid">
              <div className="detail-cell">
                <span>Type</span>
                <strong>{space.kind}</strong>
              </div>
              <div className="detail-cell">
                <span>Status</span>
                <strong>
                  <StatusTag value={space.status} tone={statusTone(space.status)} />
                </strong>
              </div>
              <div className="detail-cell">
                <span>Access mode</span>
                <strong>{space.accessMode}</strong>
              </div>
              <div className="detail-cell">
                <span>Source ACL policy</span>
                <strong>{space.sourceAclMode}</strong>
              </div>
              <div className="detail-cell">
                <span>Owner member</span>
                <strong className="mono">{space.ownershipMemberId}</strong>
              </div>
              <div className="detail-cell">
                <span>Updated</span>
                <strong>{formatDate(space.updatedAt)}</strong>
              </div>
            </div>
          </Section>

          <Section title="Update metadata" meta="CAS version is submitted with this mutation">
            <form className="form-band" onSubmit={updateSpace}>
              <div className="form-intro">
                <h2>Space details</h2>
                <p>Leave a field blank to keep its current value.</p>
              </div>
              <div className="form-fields">
                <Field label="Name">
                  <TextInput
                    value={name}
                    placeholder={space.name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>
                <Field label="Description">
                  <TextArea
                    value={description}
                    placeholder={space.description}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </Field>
              </div>
              <div className="form-actions">
                <Button type="submit" tone="primary" busy={busy}>
                  Save metadata
                </Button>
              </div>
            </form>
          </Section>
        </>
      )}
    </>
  );
}
