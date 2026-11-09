import { legacyListRedirect } from '../../lib/legacy-route';

export const getServerSideProps = legacyListRedirect();

export default function LegacyNewSpacePage() {
  return null;
}
