import { legacyDatasetRedirect } from '../../../lib/legacy-route';

export const getServerSideProps = legacyDatasetRedirect('test');

export default function LegacySearchPage() {
  return null;
}
