import {
  FileUploadPanel,
  LoadingState,
  PageHeader,
  ProblemNotice,
  Section,
  knowledgeQueryKeys,
  useKnowledgeI18n,
  useKnowledgeQuery,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';
import type { SpaceRecord } from '../../../lib/knowledge-types';

export default function ImportPage() {
  const router = useRouter();
  const { t } = useKnowledgeI18n();
  const spaceId = typeof router.query.spaceId === 'string' ? router.query.spaceId : '';
  const space = useKnowledgeQuery<SpaceRecord>(
    knowledgeQueryKeys.spaces.detail(spaceId),
    spaceId ? `/v1/knowledge/spaces/${spaceId}` : null,
  );

  return (
    <>
      <Head>
        <title>
          {space.data ? t('import.title', { name: space.data.name }) : t('import.fallbackTitle')}
        </title>
      </Head>
      <PageHeader
        eyebrow={t('import.eyebrow')}
        title={t('import.heading')}
        description={t('import.description')}
      />
      <ProblemNotice error={space.error} onRetry={() => void space.refetch()} />
      <Section title={t('import.uploadTitle')} meta={t('import.uploadMeta')}>
        {!spaceId ? <LoadingState label={t('import.noSpace')} /> : null}
        {spaceId ? <FileUploadPanel knowledgeSpaceId={spaceId} /> : null}
      </Section>
    </>
  );
}
