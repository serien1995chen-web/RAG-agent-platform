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
import { useState, type FormEvent } from 'react';
import type { DirectoryRecord, SourceRecord, SpaceRecord } from '../../../lib/knowledge-types';
import { listPath, statusTone } from '../../../lib/knowledge-types';

export default function SourcesPage() {
  const router = useRouter();
  const spaceId = typeof router.query.spaceId === 'string' ? router.query.spaceId : '';
  const space = useKnowledgeRequest<SpaceRecord>(
    spaceId ? `/v1/knowledge/spaces/${spaceId}` : null,
    [spaceId],
  );
  const directories = useKnowledgeRequest<{ items: DirectoryRecord[] }>(
    spaceId ? listPath(spaceId, 'directories') : null,
    [spaceId],
  );
  const sources = useKnowledgeRequest<{ items: SourceRecord[] }>(
    spaceId ? listPath(spaceId, 'sources') : null,
    [spaceId],
  );
  const [kind, setKind] = useState('text');
  const [name, setName] = useState('');
  const [directoryId, setDirectoryId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function createSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!spaceId) return;
    setBusy(true);
    setError(null);
    try {
      await knowledgeRequest(`/v1/knowledge/spaces/${spaceId}/sources`, {
        method: 'POST',
        body: {
          kind,
          name,
          ...(directoryId ? { directoryId } : {}),
          searchEnabled: true,
          metadata: {},
        },
      });
      setName('');
      await sources.reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function deleteSource(source: SourceRecord) {
    if (!window.confirm(`Delete ${source.name}? A delete job will be created.`)) return;
    setBusy(true);
    setError(null);
    try {
      await knowledgeRequest(`/v1/knowledge/sources/${source.id}`, {
        method: 'DELETE',
        body: {},
      });
      await sources.reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Head>
        <title>{space.data ? `${space.data.name} sources` : 'Sources'}</title>
      </Head>
      <PageHeader
        eyebrow="Knowledge catalog"
        title="Sources"
        description="File, text, URL and external-source records. Content import remains deferred."
      />
      <ProblemNotice error={space.error ?? directories.error ?? sources.error ?? error} />
      <Section title="Create Source" meta="Synchronous metadata only">
        <form className="form-band" onSubmit={createSource}>
          <div className="form-intro">
            <h2>Source record</h2>
            <p>Creates an empty Source. It does not start a parsing pipeline.</p>
          </div>
          <div className="form-fields">
            <Field label="Name">
              <TextInput
                required
                maxLength={240}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="Kind">
              <SelectInput value={kind} onChange={(event) => setKind(event.target.value)}>
                <option value="text">Text</option>
                <option value="file">File</option>
                <option value="url">URL</option>
                <option value="template">Template</option>
                <option value="image">Image</option>
              </SelectInput>
            </Field>
            <Field label="Directory">
              <SelectInput
                value={directoryId}
                onChange={(event) => setDirectoryId(event.target.value)}
              >
                <option value="">No directory</option>
                {directories.data?.items.map((directory) => (
                  <option key={directory.id} value={directory.id}>
                    {directory.name}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>
          <div className="form-actions">
            <Button type="submit" tone="primary" busy={busy}>
              Create Source
            </Button>
          </div>
        </form>
      </Section>
      <Section
        title="Source register"
        meta={sources.data ? `${sources.data.items.length} records` : undefined}
      >
        {sources.loading ? (
          <LoadingState />
        ) : (
          <DataTable
            rows={sources.data?.items ?? []}
            rowKey={(source) => source.id}
            empty="No Sources exist in this space."
            columns={[
              { key: 'name', label: 'Name', render: (source) => source.name },
              { key: 'kind', label: 'Kind', render: (source) => source.kind },
              {
                key: 'status',
                label: 'Status',
                render: (source) => (
                  <StatusTag
                    value={source.processingStatus}
                    tone={statusTone(source.processingStatus)}
                  />
                ),
              },
              {
                key: 'permission',
                label: 'Permission',
                render: (source) => `${source.permissionState} / r${source.permissionRevision}`,
              },
              {
                key: 'actions',
                label: 'Actions',
                render: (source) => (
                  <div className="inline-actions">
                    <a
                      className="button button-small"
                      href={`/spaces/${spaceId}/segments?sourceId=${source.id}`}
                    >
                      Segments
                    </a>
                    <Button
                      className="button-small"
                      tone="danger"
                      busy={busy}
                      onClick={() => void deleteSource(source)}
                    >
                      Delete
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
