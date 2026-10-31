import {
  Button,
  Field,
  PageHeader,
  S10UsageDashboard,
  Section,
  SelectInput,
  TextInput,
  knowledgeQueryKeys,
  usagePath,
  useKnowledgeI18n,
  useKnowledgeQuery,
  type S10UsageSummary,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useState } from 'react';

function queryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function UsagePage() {
  const { t } = useKnowledgeI18n();
  const router = useRouter();
  const [filters, setFilters] = useState({
    from: queryValue(router.query.from) ?? '',
    to: queryValue(router.query.to) ?? '',
    type: queryValue(router.query.type) ?? '',
    spaceId: queryValue(router.query.spaceId) ?? '',
  });
  const params = {
    ...(queryValue(router.query.from) ? { from: queryValue(router.query.from)! } : {}),
    ...(queryValue(router.query.to) ? { to: queryValue(router.query.to)! } : {}),
    ...(queryValue(router.query.type) ? { type: queryValue(router.query.type)! } : {}),
    ...(queryValue(router.query.spaceId) ? { spaceId: queryValue(router.query.spaceId)! } : {}),
  };
  const summary = useKnowledgeQuery<S10UsageSummary>(
    knowledgeQueryKeys.usage.summary(params),
    usagePath(params),
  );
  return (
    <>
      <Head>
        <title>{t('usage.title')}</title>
      </Head>
      <PageHeader
        eyebrow={t('usage.eyebrow')}
        title={t('usage.heading')}
        description={t('usage.description')}
      />
      <Section title={t('usage.filters')}>
        <div className="filter-grid">
          <Field label={t('audit.from')}>
            <TextInput
              type="datetime-local"
              value={filters.from}
              onChange={(event) => setFilters({ ...filters, from: event.target.value })}
            />
          </Field>
          <Field label={t('audit.to')}>
            <TextInput
              type="datetime-local"
              value={filters.to}
              onChange={(event) => setFilters({ ...filters, to: event.target.value })}
            />
          </Field>
          <Field label={t('usage.type')}>
            <SelectInput
              value={filters.type}
              onChange={(event) => setFilters({ ...filters, type: event.target.value })}
            >
              <option value="">{t('usage.allTypes')}</option>
              {[
                'parse',
                'ocr',
                'embedding',
                'rerank',
                'llm',
                'vlm',
                'stt',
                'tts',
                'storage',
                'sync',
              ].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label={t('usage.space')}>
            <TextInput
              value={filters.spaceId}
              onChange={(event) => setFilters({ ...filters, spaceId: event.target.value })}
            />
          </Field>
          <Button
            tone="primary"
            onClick={() =>
              void router.replace({
                pathname: '/usage',
                query: Object.fromEntries(
                  Object.entries(filters).filter(([, value]) => value.length > 0),
                ),
              })
            }
          >
            {t('audit.apply')}
          </Button>
        </div>
      </Section>
      <S10UsageDashboard
        summary={summary.data}
        loading={summary.isLoading}
        error={summary.error}
        onRetry={() => void summary.refetch()}
      />
    </>
  );
}
