import type { GetServerSideProps } from 'next';

export const getServerSideProps: GetServerSideProps = async (context) => {
  const spaceId = typeof context.query.spaceId === 'string' ? context.query.spaceId : '';
  return {
    redirect: {
      destination: spaceId
        ? `/dataset/detail?datasetId=${encodeURIComponent(spaceId)}&currentTab=collectionCard`
        : '/dataset/list',
      permanent: false,
    },
  };
};

export default function JobsRoute() {
  return null;
}
