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
    if (tab === 'import') {
      const explicitSource = typeof context.query.source === 'string' ? context.query.source : '';
      const legacyKind = typeof context.query.kind === 'string' ? context.query.kind : '';
      const source =
        explicitSource ||
        (
          {
            file: 'fileLocal',
            local: 'fileLocal',
            url: 'fileLink',
            link: 'fileLink',
            text: 'fileCustom',
            custom: 'fileCustom',
            image: 'imageDataset',
            template: 'template',
            backup: 'backup',
            retraining: 'reTraining',
          } as Record<string, string>
        )[legacyKind];
      if (source) query.set('source', source);
      for (const key of ['parentId', 'collectionId', 'importJobId']) {
        const value = context.query[key];
        if (typeof value === 'string' && value) query.set(key, value);
      }
    }
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
