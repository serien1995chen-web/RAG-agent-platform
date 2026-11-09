import { legacyDatasetRedirect } from '../../../lib/legacy-route';

export const getServerSideProps = legacyDatasetRedirect('collectionCard');

export default function LegacySynonymsPage() {
  return null;
}
