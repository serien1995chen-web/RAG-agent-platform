import { legacyDatasetRedirect } from '../../../lib/legacy-route';

export const getServerSideProps = legacyDatasetRedirect('collectionCard');

export default function LegacyAccessPage() {
  return null;
}
