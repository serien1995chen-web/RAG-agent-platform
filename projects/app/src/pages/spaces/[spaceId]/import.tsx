import { legacyDatasetRedirect } from '../../../lib/legacy-route';

export const getServerSideProps = legacyDatasetRedirect('import');

export default function LegacyImportPage() {
  return null;
}
