import {
  ConnectorsPanel,
  LoadingState,
  PageHeader,
  ProblemNotice,
  knowledgeQueryKeys,
  useKnowledgeI18n,
  useKnowledgeQuery,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';
import type { SpaceRecord } from '../../lib/knowledge-types';

export default function ConnectorsPage() {
  const router = useRouter();
  const { t } = useKnowledgeI18n();
  const spaceId = typeof router.query.spaceId === 'string' ? router.query.spaceId : '';
  const provider = typeof router.query.provider === 'string' ? router.query.provider : undefined;
  const connectorId =
    typeof router.query.connectorId === 'string' ? router.query.connectorId : undefined;
  const space = useKnowledgeQuery<SpaceRecord>(
    knowledgeQueryKeys.spaces.detail(spaceId),
    spaceId ? `/v1/knowledge/spaces/${spaceId}` : null,
  );

  return (
    <>
      <Head>
        <title>{t('connectors.title')}</title>
      </Head>
      <PageHeader
        eyebrow={t('connectors.eyebrow')}
        title={t('connectors.heading')}
        description={t('connectors.description')}
      />
      <ProblemNotice error={space.error} onRetry={() => void space.refetch()} />
      {!spaceId ? <LoadingState label={t('import.noSpace')} /> : null}
      {spaceId ? (
        <ConnectorsPanel
          spaceId={spaceId}
          initialProvider={provider}
          initialConnectorId={connectorId}
        />
      ) : null}
    </>
  );
}
