import type { GetServerSideProps } from 'next';

export const getServerSideProps: GetServerSideProps = async () => ({
  redirect: {
    destination: '/dataset/list',
    permanent: false,
  },
});

export default function OperationsPage() {
  return null;
}
