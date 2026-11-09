export async function getServerSideProps() {
  return {
    redirect: {
      destination: '/dataset/list',
      permanent: true,
    },
  };
}

export default function IndexPage() {
  return null;
}
