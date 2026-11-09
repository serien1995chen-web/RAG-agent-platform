import type { GetServerSideProps } from 'next';

export function legacyDatasetRedirect(
  tab: 'collectionCard' | 'dataCard' | 'test' | 'import',
): GetServerSideProps {
  return async (context) => {
    const spaceId = typeof context.query.spaceId === 'string' ? context.query.spaceId : '';
    if (!spaceId) {
      return { redirect: { destination: '/dataset/list', permanent: false } };
    }
    const query = new URLSearchParams({ datasetId: spaceId, currentTab: tab });
    return {
      redirect: {
        destination: `/dataset/detail?${query.toString()}`,
        permanent: false,
      },
    };
  };
}

export function legacyListRedirect(): GetServerSideProps {
  return async () => ({
    redirect: {
      destination: '/dataset/list',
      permanent: false,
    },
  });
}
