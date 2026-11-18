import { JobsPage } from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';

export default function JobsRoute() {
  const router = useRouter();
  const spaceId = Array.isArray(router.query.spaceId)
    ? (router.query.spaceId[0] ?? '')
    : (router.query.spaceId ?? '');

  return (
    <>
      <Head>
        <title>任务中心</title>
      </Head>
      {router.isReady ? <JobsPage spaceId={spaceId} /> : null}
    </>
  );
}
