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
  TextArea,
  TextInput,
  knowledgeRequest,
  useKnowledgeRequest,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useState, type FormEvent } from 'react';
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
  const spaceId = typeof router.query.spaceId === 'string' ? router.query.spaceId : '';
  const sourceFromQuery = typeof router.query.sourceId === 'string' ? router.query.sourceId : '';
  const [sourceId, setSourceId] = useState(sourceFromQuery);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const space = useKnowledgeRequest<SpaceRecord>(
    spaceId ? `/v1/knowledge/spaces/${spaceId}` : null,
    [spaceId],
  );
  const sources = useKnowledgeRequest<{ items: SourceRecord[] }>(
    spaceId ? listPath(spaceId, 'sources') : null,
    [spaceId],
  );
  const segments = useKnowledgeRequest<SegmentResponse>(
    sourceId ? `/v1/knowledge/sources/${sourceId}/segments?limit=200&sort=order` : null,
    [sourceId],
  );

  useEffect(() => {
    if (!sourceId && sources.data?.items[0]) {
      setSourceId(sources.data.items[0].id);
    }
  }, [sourceId, sources.data]);

  async function createSegment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sourceId) return;
    setBusy(true);
    setError(null);
    try {
      await knowledgeRequest(`/v1/knowledge/sources/${sourceId}/segments`, {
        method: 'POST',
        body: { question, answer, searchEnabled: true, metadata: {} },
      });
      setQuestion('');
      setAnswer('');
      await segments.reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function deleteSegment(segment: SegmentRecord) {
    if (!window.confirm(`Delete segment ${segment.order}? A delete job will be created.`)) return;
    setBusy(true);
    setError(null);
    try {
      await knowledgeRequest(`/v1/knowledge/segments/${segment.id}`, {
        method: 'DELETE',
        body: {},
      });
      await segments.reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Head>
        <title>{space.data ? `${space.data.name} segments` : 'Segments'}</title>
      </Head>
      <PageHeader
        eyebrow="Knowledge content"
        title="Segments"
        description="Editable retrieval units. Indexing pipelines remain deferred."
      />
      <ProblemNotice error={space.error ?? sources.error ?? segments.error ?? error} />
      <div className="selector-row">
        <Field label="Source">
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
            <option value="">Select a Source</option>
            {sources.data?.items.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </SelectInput>
        </Field>
      </div>

      <Section title="Create Segment" meta="Source searchEnabled remains the upper bound">
        <form className="form-band" onSubmit={createSegment}>
          <div className="form-intro">
            <h2>Segment text</h2>
            <p>Each Segment receives the next order value for its Source.</p>
          </div>
          <div className="form-fields">
            <Field label="Question">
              <TextInput
                required
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
              />
            </Field>
            <Field label="Answer">
              <TextArea
                required
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
              />
            </Field>
          </div>
          <div className="form-actions">
            <Button type="submit" tone="primary" busy={busy} disabled={!sourceId}>
              Create Segment
            </Button>
          </div>
        </form>
      </Section>

      <Section
        title="Segment register"
        meta={segments.data ? `${segments.data.items.length} records` : undefined}
      >
        {segments.loading ? (
          <LoadingState />
        ) : (
          <DataTable
            rows={segments.data?.items ?? []}
            rowKey={(segment) => segment.id}
            empty="Select a Source or create its first Segment."
            columns={[
              { key: 'order', label: 'Order', render: (segment) => segment.order },
              { key: 'question', label: 'Question', render: (segment) => segment.question },
              {
                key: 'status',
                label: 'Index status',
                render: (segment) => (
                  <StatusTag value={segment.indexStatus} tone={statusTone(segment.indexStatus)} />
                ),
              },
              {
                key: 'search',
                label: 'Search',
                render: (segment) => (segment.searchEnabled ? 'enabled' : 'disabled'),
              },
              {
                key: 'version',
                label: 'Version',
                render: (segment) => segment.version,
              },
              {
                key: 'actions',
                label: 'Actions',
                render: (segment) => (
                  <Button
                    className="button-small"
                    tone="danger"
                    busy={busy}
                    onClick={() => void deleteSegment(segment)}
                  >
                    Delete
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
