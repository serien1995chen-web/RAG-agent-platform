import {
  FormBand,
  FormField,
  PageHeader,
  ProblemNotice,
  SelectInput,
  TextArea,
  TextInput,
  knowledgeQueryKeys,
  knowledgeRequest,
  newSpaceFormSchema,
  submitWithProblem,
  useKnowledgeI18n,
  useKnowledgeForm,
  useKnowledgeMutation,
  type NewSpaceFormValues,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useState } from 'react';
import type { SpaceRecord } from '../../lib/knowledge-types';

export default function NewSpacePage() {
  const router = useRouter();
  const { t } = useKnowledgeI18n();
  const [problem, setProblem] = useState<unknown>(null);
  const form = useKnowledgeForm(newSpaceFormSchema, {
    defaultValues: {
      kind: 'space',
      name: '',
      description: '',
      accessMode: 'workspace',
      sourceAclMode: 'enforced',
      sourcePermissionEnabled: true,
    },
  });
  const createSpace = useKnowledgeMutation<SpaceRecord, NewSpaceFormValues>({
    mutationFn: (values) =>
      knowledgeRequest<SpaceRecord>('/v1/knowledge/spaces', {
        method: 'POST',
        body: {
          ...values,
          iconKey: 'book-open',
        },
      }),
    invalidateKeys: [knowledgeQueryKeys.spaces.list({ limit: 200 })],
    onSuccess: async (space) => {
      await router.push(`/spaces/${space.id}/overview`);
    },
  });

  const submit = form.handleSubmit(async (values) => {
    await submitWithProblem(
      async () => {
        await createSpace.mutateAsync(values);
      },
      setProblem,
      form,
    );
  });

  return (
    <>
      <Head>
        <title>{t('newSpace.title')}</title>
      </Head>
      <PageHeader
        eyebrow={t('newSpace.eyebrow')}
        title={t('newSpace.heading')}
        description={t('newSpace.description')}
      />
      <ProblemNotice error={problem ?? createSpace.error} />
      <FormBand
        title={t('newSpace.formTitle')}
        description={t('newSpace.formDescription')}
        submitLabel={t('newSpace.submit')}
        busy={createSpace.isLoading}
        onSubmit={submit}
      >
        <FormField
          control={form.control}
          name="kind"
          label={t('newSpace.type')}
          render={(field) => (
            <SelectInput
              name={field.name}
              value={String(field.value)}
              onBlur={field.onBlur}
              onChange={(event) => field.onChange(event.target.value as 'space' | 'folder')}
            >
              <option value="space">{t('enum.space')}</option>
              <option value="folder">{t('enum.folder')}</option>
            </SelectInput>
          )}
        />
        <FormField
          control={form.control}
          name="name"
          label={t('newSpace.name')}
          render={(field) => (
            <TextInput
              {...field}
              required
              maxLength={120}
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
              value={String(field.value)}
              onChange={(event) => field.onChange(event.target.value)}
            />
          )}
        />
        <FormField
          control={form.control}
          name="accessMode"
          label={t('newSpace.access')}
          render={(field) => (
            <SelectInput
              name={field.name}
              value={String(field.value)}
              onBlur={field.onBlur}
              onChange={(event) => field.onChange(event.target.value as 'workspace' | 'restricted')}
            >
              <option value="workspace">{t('enum.workspace')}</option>
              <option value="restricted">{t('enum.restricted')}</option>
            </SelectInput>
          )}
        />
        <FormField
          control={form.control}
          name="sourceAclMode"
          label={t('newSpace.sourceAcl')}
          render={(field) => (
            <SelectInput
              name={field.name}
              value={String(field.value)}
              onBlur={field.onBlur}
              onChange={(event) => field.onChange(event.target.value as 'inherited' | 'enforced')}
            >
              <option value="enforced">{t('enum.enforced')}</option>
              <option value="inherited">{t('enum.inherited')}</option>
            </SelectInput>
          )}
        />
        <FormField
          control={form.control}
          name="sourcePermissionEnabled"
          label={t('newSpace.sourcePermissions')}
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
              {t('newSpace.sourcePermissionEnabled')}
            </label>
          )}
        />
      </FormBand>
    </>
  );
}
