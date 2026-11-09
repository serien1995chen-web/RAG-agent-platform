import { DatasetListPage } from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';

function queryValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export default function DatasetListRoute() {
  const router = useRouter();
  const parentId = queryValue(router.query.parentId);

  return (
    <>
      <Head>
        <title>我的知识库</title>
      </Head>
      <DatasetListPage parentId={parentId} />
    </>
  );
}
