import { legacyDatasetRedirect } from '../../../lib/legacy-route';

export const getServerSideProps = legacyDatasetRedirect('dataCard');

export default function LegacySegmentsPage() {
  return null;
}
