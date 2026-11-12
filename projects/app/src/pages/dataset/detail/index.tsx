import {
  DatasetDetailPage,
  ProductAppShell,
  ProductPage,
  ProductSkeleton,
  type DatasetDetailQuery,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';

function queryValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export default function DatasetDetailRoute() {
  const router = useRouter();
  const datasetId = queryValue(router.query.datasetId);
  const currentTab = queryValue(router.query.currentTab);
  const parentId = queryValue(router.query.parentId);
  const collectionId = queryValue(router.query.collectionId);
  const source = queryValue(router.query.source);
  const importJobId = queryValue(router.query.importJobId);

  if (!router.isReady) {
    return (
      <ProductAppShell active="knowledge" title="知识库详情">
        <ProductPage>
          <ProductSkeleton rows={3} />
        </ProductPage>
      </ProductAppShell>
    );
  }

  return (
    <>
      <Head>
        <title>知识库详情</title>
      </Head>
      <DatasetDetailPage
        query={{
          datasetId,
          ...(currentTab ? { currentTab } : {}),
          ...(parentId ? { parentId } : {}),
          ...(collectionId ? { collectionId } : {}),
          ...(source ? { source } : {}),
          ...(importJobId ? { importJobId } : {}),
        }}
        onQueryChange={(next: DatasetDetailQuery, options) => {
          const query = Object.fromEntries(
            Object.entries(next).filter(([, value]) => Boolean(value)),
          );
          const location = { pathname: '/dataset/detail', query };
          if (options?.replace) {
            void router.replace(location, undefined, { shallow: true });
          } else {
            void router.push(location, undefined, { shallow: true });
          }
        }}
      />
    </>
  );
}
