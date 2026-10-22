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
import type { SourceRecord, SpaceRecord, TagRecord } from '../../../lib/knowledge-types';
import { listPath, statusTone } from '../../../lib/knowledge-types';

export default function TagsPage() {
  const router = useRouter();
  const spaceId = typeof router.query.spaceId === 'string' ? router.query.spaceId : '';
  const space = useKnowledgeRequest<SpaceRecord>(
    spaceId ? `/v1/knowledge/spaces/${spaceId}` : null,
    [spaceId],
  );
  const tags = useKnowledgeRequest<{ items: TagRecord[] }>(
    spaceId ? listPath(spaceId, 'tags') : null,
    [spaceId],
  );
  const sources = useKnowledgeRequest<{ items: SourceRecord[] }>(
    spaceId ? listPath(spaceId, 'sources') : null,
    [spaceId],
  );
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [tagType, setTagType] = useState<'string' | 'number' | 'datetime' | 'array'>('string');
  const [options, setOptions] = useState('support,sales,finance');
  const [required, setRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [selectedTagId, setSelectedTagId] = useState('');
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [tagValue, setTagValue] = useState('');

  const selectedTag = tags.data?.items.find((tag) => tag.id === selectedTagId);

  useEffect(() => {
    if (!selectedTagId && tags.data?.items[0]) setSelectedTagId(tags.data.items[0].id);
    if (!selectedSourceId && sources.data?.items[0]) setSelectedSourceId(sources.data.items[0].id);
  }, [selectedSourceId, selectedTagId, sources.data, tags.data]);

  async function createTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!spaceId) return;
    setBusy(true);
    setError(null);
    try {
      await knowledgeRequest(`/v1/knowledge/spaces/${spaceId}/tags`, {
        method: 'POST',
        body: {
          key,
          label,
          tagType,
          required,
          options:
            tagType === 'string' || tagType === 'array'
              ? options
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean)
              : null,
        },
      });
      setKey('');
      setLabel('');
      await tags.reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function deleteTag(tag: TagRecord) {
    if (!window.confirm(`Delete tag ${tag.label}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await knowledgeRequest(`/v1/knowledge/tags/${tag.id}`, { method: 'DELETE' });
      await tags.reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function applyTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTag || !selectedSourceId) return;
    setBusy(true);
    setError(null);
    try {
      const value =
        selectedTag.tagType === 'number'
          ? Number(tagValue)
          : selectedTag.tagType === 'array'
            ? tagValue
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean)
            : tagValue;
      await knowledgeRequest('/v1/knowledge/sources/tag-assignments', {
        method: 'POST',
        body: { items: [{ sourceId: selectedSourceId, tagId: selectedTag.id, value }] },
      });
      setTagValue('');
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
        <title>{space.data ? `${space.data.name} tags` : 'Tags'}</title>
      </Head>
      <PageHeader
        eyebrow="Taxonomy"
        title="Tags"
        description="Typed definitions, controlled options and Source assignments."
      />
      <ProblemNotice error={space.error ?? tags.error ?? sources.error ?? error} />
      <Section title="Create Tag" meta="Definitions are unique per key">
        <form className="form-band" onSubmit={createTag}>
          <div className="form-intro">
            <h2>Tag definition</h2>
            <p>String and array Tags require an explicit option set.</p>
          </div>
          <div className="form-fields">
            <Field label="Key">
              <TextInput
                required
                pattern="^[a-z][a-z0-9_]{1,63}$"
                value={key}
                onChange={(event) => setKey(event.target.value)}
              />
            </Field>
            <Field label="Label">
              <TextInput
                required
                maxLength={80}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </Field>
            <Field label="Value type">
              <SelectInput
                value={tagType}
                onChange={(event) => setTagType(event.target.value as typeof tagType)}
              >
                <option value="string">String</option>
                <option value="number">Number</option>
                <option value="datetime">Datetime</option>
                <option value="array">Array</option>
              </SelectInput>
            </Field>
            <Field label="Options" hint="Comma-separated for string and array">
              <TextInput
                value={options}
                disabled={tagType === 'number' || tagType === 'datetime'}
                onChange={(event) => setOptions(event.target.value)}
              />
            </Field>
            <label className="checkbox-row full">
              <input
                type="checkbox"
                checked={required}
                onChange={(event) => setRequired(event.target.checked)}
              />
              Required on Source
            </label>
          </div>
          <div className="form-actions">
            <Button type="submit" tone="primary" busy={busy}>
              Create Tag
            </Button>
          </div>
        </form>
      </Section>

      <Section
        title="Tag register"
        meta={tags.data ? `${tags.data.items.length} records` : undefined}
      >
        {tags.loading ? (
          <LoadingState />
        ) : (
          <DataTable
            rows={tags.data?.items ?? []}
            rowKey={(tag) => tag.id}
            empty="No tags are defined."
            columns={[
              { key: 'label', label: 'Label', render: (tag) => tag.label },
              {
                key: 'key',
                label: 'Key',
                render: (tag) => <span className="mono">{tag.key}</span>,
              },
              { key: 'type', label: 'Type', render: (tag) => tag.tagType },
              {
                key: 'options',
                label: 'Options',
                render: (tag) => tag.options?.join(', ') ?? '-',
              },
              {
                key: 'status',
                label: 'Status',
                render: (tag) => <StatusTag value={tag.status} tone={statusTone(tag.status)} />,
              },
              {
                key: 'actions',
                label: 'Actions',
                render: (tag) => (
                  <Button
                    className="button-small"
                    tone="danger"
                    busy={busy}
                    onClick={() => void deleteTag(tag)}
                  >
                    Delete
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Section>

      <Section title="Assign Tag" meta="Updates Source and tag-value facts">
        <form className="form-band" onSubmit={applyTag}>
          <div className="form-intro">
            <h2>Source assignment</h2>
            <p>Choose an existing Source and Tag definition.</p>
          </div>
          <div className="form-fields">
            <Field label="Source">
              <SelectInput
                value={selectedSourceId}
                onChange={(event) => setSelectedSourceId(event.target.value)}
              >
                <option value="">Select Source</option>
                {sources.data?.items.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Tag">
              <SelectInput
                value={selectedTagId}
                onChange={(event) => setSelectedTagId(event.target.value)}
              >
                <option value="">Select Tag</option>
                {tags.data?.items.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.label}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Value">
              <TextInput value={tagValue} onChange={(event) => setTagValue(event.target.value)} />
            </Field>
          </div>
          <div className="form-actions">
            <Button
              type="submit"
              tone="primary"
              busy={busy}
              disabled={!selectedTagId || !selectedSourceId}
            >
              Apply Tag
            </Button>
          </div>
        </form>
      </Section>
    </>
  );
}
