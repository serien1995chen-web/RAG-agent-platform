export async function getServerSideProps() {
  return {
    redirect: {
      destination: '/spaces',
      permanent: false,
    },
  };
}

export default function IndexPage() {
  return null;
}
