import {
  PageHeader,
  S10AuditPanel,
  auditPath,
  knowledgeQueryKeys,
  useKnowledgeI18n,
  useKnowledgeQuery,
  type S10AuditFilters,
  type S10AuditList,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';

function queryValue(value: string | string[] | undefined): string {
  const result = Array.isArray(value) ? value[0] : value;
  return result ?? '';
}

export default function AuditPage() {
  const { t } = useKnowledgeI18n();
  const router = useRouter();
  const filters: S10AuditFilters = {
    action: queryValue(router.query.action),
    actor: queryValue(router.query.actor),
    resourceType: queryValue(router.query.resourceType),
    resourceId: queryValue(router.query.resourceId),
    outcome: queryValue(router.query.outcome),
    from: queryValue(router.query.from),
    to: queryValue(router.query.to),
  };
  const params = Object.fromEntries(
    Object.entries(filters)
      .filter(([, value]) => value.length > 0)
      .map(([key, value]) => [key, value]),
  );
  const audit = useKnowledgeQuery<S10AuditList>(
    knowledgeQueryKeys.audit.list(params),
    auditPath(params),
  );
  return (
    <>
      <Head>
        <title>{t('audit.title')}</title>
      </Head>
      <PageHeader
        eyebrow={t('audit.eyebrow')}
        title={t('audit.heading')}
        description={t('audit.description')}
      />
      <S10AuditPanel
        data={audit.data}
        loading={audit.isLoading}
        error={audit.error}
        filters={filters}
        onFilters={(next) =>
          void router.replace({
            pathname: '/audit',
            query: Object.fromEntries(Object.entries(next).filter(([, value]) => value)),
          })
        }
        onRetry={() => void audit.refetch()}
      />
    </>
  );
}
