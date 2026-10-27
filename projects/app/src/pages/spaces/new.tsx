import {
  FormBand,
  FormField,
  PageHeader,
  ProblemNotice,
  S5ModelBindingPanel,
  SelectInput,
  TextArea,
  TextInput,
  knowledgeQueryKeys,
  knowledgeRequest,
  newSpaceFormSchema,
  submitWithProblem,
  useKnowledgeI18n,
  useKnowledgeForm,
  useKnowledgeModelCatalog,
  useKnowledgeMutation,
  type S5ModelBindingView,
  type S5ModelValidationView,
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
  const [createdSpace, setCreatedSpace] = useState<SpaceRecord | null>(null);
  const modelsRequest = useKnowledgeModelCatalog();
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
    onSuccess: (space) => {
      setCreatedSpace(space);
    },
  });

  const submit = form.handleSubmit(async (values) => {
    await submitWithProblem(
      async () => {
        const space = createdSpace ?? (await createSpace.mutateAsync(values));
        await router.push(`/spaces/${space.id}/overview`);
      },
      setProblem,
      form,
    );
  });

  const saveBindings = async (input: { bindings: S5ModelBindingView[]; version: number }) => {
    const valid = await form.trigger();
    if (!valid) return;
    let space = createdSpace;
    try {
      space ??= await createSpace.mutateAsync(form.getValues());
      await knowledgeRequest(`/v1/knowledge/spaces/${space.id}/model-bindings`, {
        method: 'PUT',
        body: {
          bindings: input.bindings,
          version: space.version,
        },
      });
      await router.push(`/spaces/${space.id}/overview`);
    } catch (caught) {
      setProblem(caught);
      throw caught;
    }
  };

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
        {form.watch('kind') === 'space' ? (
          <div style={{ gridColumn: '1 / -1' }}>
            <S5ModelBindingPanel
              models={modelsRequest.data?.items ?? []}
              bindings={[]}
              spaceVersion={createdSpace?.version ?? 1}
              onValidate={validateBinding}
              onSave={saveBindings}
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
          </div>
        ) : null}
      </FormBand>
    </>
  );
}
