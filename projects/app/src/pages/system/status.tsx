import {
  PageHeader,
  S10SystemStatus,
  cleanup,
  knowledgeQueryKeys,
  reconcile,
  useKnowledgeI18n,
  useKnowledgeMutation,
  useKnowledgeQuery,
  type S10Status,
} from '@kb/web';
import Head from 'next/head';
export default function SystemStatusPage() {
  const { t } = useKnowledgeI18n();
  const status = useKnowledgeQuery<S10Status>(
    knowledgeQueryKeys.operations.status,
    '/v1/knowledge/operations/status',
  );
  const cleanupMutation = useKnowledgeMutation({
    mutationFn: (scope: string) => cleanup(scope),
    invalidateKeys: [knowledgeQueryKeys.operations.status],
  });
  const reconcileMutation = useKnowledgeMutation({
    mutationFn: (input: { scope: string; repair: boolean }) => reconcile(input.scope, input.repair),
    invalidateKeys: [knowledgeQueryKeys.operations.status],
  });

  return (
    <>
      <Head>
        <title>{t('status.title')}</title>
      </Head>
      <PageHeader
        eyebrow={t('status.eyebrow')}
        title={t('status.heading')}
        description={t('status.description')}
      />
      <S10SystemStatus
        status={status.data}
        loading={status.isLoading}
        error={status.error}
        busy={cleanupMutation.isLoading || reconcileMutation.isLoading}
        onRetry={() => void status.refetch()}
        onCleanup={(scope) => cleanupMutation.mutateAsync(scope)}
        onReconcile={(scope, repair) => reconcileMutation.mutateAsync({ scope, repair })}
      />
    </>
  );
}
