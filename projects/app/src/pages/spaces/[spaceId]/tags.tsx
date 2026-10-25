import {
  Button,
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
  submitWithProblem,
  tagAssignmentFormSchema,
  tagFormSchema,
  useKnowledgeEnumLabel,
  useKnowledgeForm,
  useKnowledgeI18n,
  useKnowledgeMutation,
  useKnowledgeQuery,
  type TagAssignmentFormValues,
  type TagFormValues,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import type { SourceRecord, SpaceRecord, TagRecord } from '../../../lib/knowledge-types';
import { listPath, statusTone } from '../../../lib/knowledge-types';

export default function TagsPage() {
  const router = useRouter();
  const { t } = useKnowledgeI18n();
  const enumLabel = useKnowledgeEnumLabel();
  const spaceId = typeof router.query.spaceId === 'string' ? router.query.spaceId : '';
  const [problem, setProblem] = useState<unknown>(null);
  const space = useKnowledgeQuery<SpaceRecord>(
    knowledgeQueryKeys.spaces.detail(spaceId),
    spaceId ? `/v1/knowledge/spaces/${spaceId}` : null,
  );
  const tags = useKnowledgeQuery<{ items: TagRecord[] }>(
    knowledgeQueryKeys.tags.list(spaceId),
    spaceId ? listPath(spaceId, 'tags') : null,
  );
  const sources = useKnowledgeQuery<{ items: SourceRecord[] }>(
    knowledgeQueryKeys.sources.list(spaceId),
    spaceId ? listPath(spaceId, 'sources') : null,
  );
  const createTagForm = useKnowledgeForm(tagFormSchema, {
    defaultValues: {
      key: '',
      label: '',
      tagType: 'string',
      options: 'support,sales,finance',
      required: false,
    },
  });
  const assignmentForm = useKnowledgeForm(tagAssignmentFormSchema, {
    defaultValues: { sourceId: '', tagId: '', value: '' },
  });
  const selectedTagId = assignmentForm.watch('tagId');
  const selectedSourceId = assignmentForm.watch('sourceId');
  const selectedTag = tags.data?.items.find((tag) => tag.id === selectedTagId);
  const createTagType = createTagForm.watch('tagType');

  useEffect(() => {
    if (!selectedTagId && tags.data?.items[0]) {
      assignmentForm.setValue('tagId', tags.data.items[0].id);
    }
    if (!selectedSourceId && sources.data?.items[0]) {
      assignmentForm.setValue('sourceId', sources.data.items[0].id);
    }
  }, [assignmentForm, selectedSourceId, selectedTagId, sources.data, tags.data]);

  const createTag = useKnowledgeMutation<TagRecord, TagFormValues>({
    mutationFn: (values) =>
      knowledgeRequest<TagRecord>(`/v1/knowledge/spaces/${spaceId}/tags`, {
        method: 'POST',
        body: {
          key: values.key,
          label: values.label,
          tagType: values.tagType,
          required: values.required,
          options:
            values.tagType === 'string' || values.tagType === 'array'
              ? values.options
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean)
              : null,
        },
      }),
    invalidateKeys: [knowledgeQueryKeys.tags.list(spaceId)],
    onSuccess: () => {
      createTagForm.reset();
    },
  });
  const deleteTag = useKnowledgeMutation<void, string>({
    mutationFn: (tagId) =>
      knowledgeRequest<void>(`/v1/knowledge/tags/${tagId}`, { method: 'DELETE' }),
    invalidateKeys: [
      knowledgeQueryKeys.tags.list(spaceId),
      knowledgeQueryKeys.sources.list(spaceId),
    ],
  });
  const applyTag = useKnowledgeMutation<void, TagAssignmentFormValues>({
    mutationFn: (values) => {
      const tag = tags.data?.items.find((item) => item.id === values.tagId);
      const value =
        tag?.tagType === 'number'
          ? Number(values.value)
          : tag?.tagType === 'array'
            ? values.value
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean)
            : values.value;
      return knowledgeRequest<void>('/v1/knowledge/sources/tag-assignments', {
        method: 'POST',
        body: { items: [{ sourceId: values.sourceId, tagId: values.tagId, value }] },
      });
    },
    invalidateKeys: [knowledgeQueryKeys.sources.list(spaceId)],
    onSuccess: () => {
      assignmentForm.setValue('value', '');
    },
  });

  const submitTag = createTagForm.handleSubmit(async (values) => {
    await submitWithProblem(
      async () => {
        await createTag.mutateAsync(values);
      },
      setProblem,
      createTagForm,
    );
  });
  const submitAssignment = assignmentForm.handleSubmit(async (values) => {
    await submitWithProblem(
      async () => {
        await applyTag.mutateAsync(values);
      },
      setProblem,
      assignmentForm,
    );
  });

  async function removeTag(tag: TagRecord) {
    if (!window.confirm(t('tags.confirmDelete', { label: tag.label }))) return;
    await submitWithProblem(async () => {
      await deleteTag.mutateAsync(tag.id);
    }, setProblem);
  }

  return (
    <>
      <Head>
        <title>
          {space.data ? t('tags.title', { name: space.data.name }) : t('tags.fallbackTitle')}
        </title>
      </Head>
      <PageHeader
        eyebrow={t('tags.eyebrow')}
        title={t('tags.heading')}
        description={t('tags.description')}
      />
      <ProblemNotice
        error={
          space.error ??
          tags.error ??
          sources.error ??
          problem ??
          createTag.error ??
          deleteTag.error ??
          applyTag.error
        }
        onRetry={() => void tags.refetch()}
      />
      <Section title={t('tags.createTitle')} meta={t('tags.createMeta')}>
        <form className="form-band" onSubmit={submitTag}>
          <div className="form-intro">
            <h2>{t('tags.formTitle')}</h2>
            <p>{t('tags.formDescription')}</p>
          </div>
          <div className="form-fields">
            <FormField
              control={createTagForm.control}
              name="key"
              label={t('tags.key')}
              render={(field) => (
                <TextInput
                  {...field}
                  required
                  pattern="^[a-z][a-z0-9_]{1,63}$"
                  value={String(field.value)}
                  onChange={(event) => field.onChange(event.target.value)}
                />
              )}
            />
            <FormField
              control={createTagForm.control}
              name="label"
              label={t('tags.label')}
              render={(field) => (
                <TextInput
                  {...field}
                  required
                  maxLength={80}
                  value={String(field.value)}
                  onChange={(event) => field.onChange(event.target.value)}
                />
              )}
            />
            <FormField
              control={createTagForm.control}
              name="tagType"
              label={t('tags.valueType')}
              render={(field) => (
                <SelectInput
                  name={field.name}
                  value={String(field.value)}
                  onBlur={field.onBlur}
                  onChange={(event) => field.onChange(event.target.value)}
                >
                  <option value="string">{t('enum.string')}</option>
                  <option value="number">{t('enum.number')}</option>
                  <option value="datetime">{t('enum.datetime')}</option>
                  <option value="array">{t('enum.array')}</option>
                </SelectInput>
              )}
            />
            <FormField
              control={createTagForm.control}
              name="options"
              label={t('tags.options')}
              hint={t('tags.optionsHint')}
              render={(field) => (
                <TextInput
                  {...field}
                  disabled={createTagType === 'number' || createTagType === 'datetime'}
                  value={String(field.value)}
                  onChange={(event) => field.onChange(event.target.value)}
                />
              )}
            />
            <FormField
              control={createTagForm.control}
              name="required"
              label={t('tags.required')}
              render={(field) => (
                <label className="checkbox-row">
                  <input
                    ref={field.ref}
                    type="checkbox"
                    name={field.name}
                    checked={Boolean(field.value)}
                    onBlur={field.onBlur}
                    onChange={(event) => field.onChange(event.target.checked)}
                  />
                  {t('tags.required')}
                </label>
              )}
            />
          </div>
          <div className="form-actions">
            <Button type="submit" tone="primary" busy={createTag.isLoading}>
              {t('tags.create')}
            </Button>
          </div>
        </form>
      </Section>

      <Section
        title={t('tags.register')}
        meta={tags.data ? t('common.records', { count: tags.data.items.length }) : undefined}
      >
        {tags.isLoading ? (
          <LoadingState />
        ) : (
          <KnowledgeDataTable
            rows={tags.data?.items ?? []}
            rowKey={(tag) => tag.id}
            empty={t('tags.empty')}
            caption={t('tags.register')}
            columns={[
              { key: 'label', label: t('tags.columnLabel'), render: (tag) => tag.label },
              {
                key: 'key',
                label: t('tags.columnKey'),
                render: (tag) => <span className="mono">{tag.key}</span>,
              },
              {
                key: 'type',
                label: t('tags.columnType'),
                render: (tag) => enumLabel(tag.tagType),
              },
              {
                key: 'options',
                label: t('tags.columnOptions'),
                render: (tag) => tag.options?.join(', ') ?? '-',
              },
              {
                key: 'status',
                label: t('tags.columnStatus'),
                render: (tag) => <StatusTag value={tag.status} tone={statusTone(tag.status)} />,
              },
              {
                key: 'actions',
                label: t('tags.columnActions'),
                render: (tag) => (
                  <Button
                    size="sm"
                    tone="danger"
                    busy={deleteTag.isLoading}
                    onClick={() => void removeTag(tag)}
                  >
                    {t('tags.delete')}
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Section>

      <Section title={t('tags.assignTitle')} meta={t('tags.assignMeta')}>
        <form className="form-band" onSubmit={submitAssignment}>
          <div className="form-intro">
            <h2>{t('tags.assignFormTitle')}</h2>
            <p>{t('tags.assignFormDescription')}</p>
          </div>
          <div className="form-fields">
            <FormField
              control={assignmentForm.control}
              name="sourceId"
              label={t('tags.source')}
              render={(field) => (
                <SelectInput
                  name={field.name}
                  value={String(field.value)}
                  onBlur={field.onBlur}
                  onChange={(event) => field.onChange(event.target.value)}
                >
                  <option value="">{t('tags.selectSource')}</option>
                  {sources.data?.items.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.name}
                    </option>
                  ))}
                </SelectInput>
              )}
            />
            <FormField
              control={assignmentForm.control}
              name="tagId"
              label={t('tags.tag')}
              render={(field) => (
                <SelectInput
                  name={field.name}
                  value={String(field.value)}
                  onBlur={field.onBlur}
                  onChange={(event) => field.onChange(event.target.value)}
                >
                  <option value="">{t('tags.selectTag')}</option>
                  {tags.data?.items.map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {tag.label}
                    </option>
                  ))}
                </SelectInput>
              )}
            />
            <FormField
              control={assignmentForm.control}
              name="value"
              label={t('tags.value')}
              render={(field) => (
                <TextInput
                  {...field}
                  value={String(field.value)}
                  onChange={(event) => field.onChange(event.target.value)}
                />
              )}
            />
            {selectedTag ? (
              <div className="selector-row">
                <StatusTag value={selectedTag.tagType} tone="neutral" />
              </div>
            ) : null}
          </div>
          <div className="form-actions">
            <Button
              type="submit"
              tone="primary"
              busy={applyTag.isLoading}
              disabled={!selectedTagId || !selectedSourceId}
            >
              {t('tags.apply')}
            </Button>
          </div>
        </form>
      </Section>
    </>
  );
}
