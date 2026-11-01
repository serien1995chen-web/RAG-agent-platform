import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const pagesRoot = join(root, 'projects', 'app', 'src', 'pages');

export const S11_VIEWPORTS = [
  { name: 'mobile', width: 360, height: 800 },
  { name: 'tablet', width: 768, height: 900 },
  { name: 'desktop', width: 1200, height: 900 },
] as const;

export const S11_CANONICAL_PAGES = [
  { id: 'PAGE-SPACES', route: '/spaces', source: 'spaces/index.tsx', phase: 'existing' },
  { id: 'PAGE-SPACE-NEW', route: '/spaces/new', source: 'spaces/new.tsx', phase: 'existing' },
  {
    id: 'PAGE-SPACE-OVERVIEW',
    route: '/spaces/[spaceId]/overview',
    source: 'spaces/[spaceId]/overview.tsx',
    phase: 'existing',
  },
  {
    id: 'PAGE-SOURCES',
    route: '/spaces/[spaceId]/sources',
    source: 'spaces/[spaceId]/sources.tsx',
    phase: 'existing',
  },
  {
    id: 'PAGE-IMPORT',
    route: '/spaces/[spaceId]/import',
    source: 'spaces/[spaceId]/import.tsx',
    phase: 'existing',
  },
  {
    id: 'PAGE-SEGMENTS',
    route: '/spaces/[spaceId]/segments',
    source: 'spaces/[spaceId]/segments.tsx',
    phase: 'existing',
  },
  {
    id: 'PAGE-SEGMENT-EDIT',
    route: '/spaces/[spaceId]/segments/[segmentId]',
    source: 'spaces/[spaceId]/segments/[segmentId].tsx',
    phase: 'existing',
  },
  {
    id: 'PAGE-JOBS',
    route: '/spaces/[spaceId]/jobs',
    source: 'spaces/[spaceId]/jobs.tsx',
    phase: 'existing',
  },
  {
    id: 'PAGE-SEARCH',
    route: '/spaces/[spaceId]/search',
    source: 'spaces/[spaceId]/search.tsx',
    phase: 'existing',
  },
  {
    id: 'PAGE-IMAGES',
    route: '/spaces/[spaceId]/images',
    source: 'spaces/[spaceId]/images.tsx',
    phase: 'existing',
  },
  {
    id: 'PAGE-TAGS',
    route: '/spaces/[spaceId]/tags',
    source: 'spaces/[spaceId]/tags.tsx',
    phase: 'existing',
  },
  {
    id: 'PAGE-ACCESS',
    route: '/spaces/[spaceId]/access',
    source: 'spaces/[spaceId]/access.tsx',
    phase: 'existing',
  },
  {
    id: 'PAGE-SYNONYMS',
    route: '/spaces/[spaceId]/synonyms',
    source: 'spaces/[spaceId]/synonyms.tsx',
    phase: 'existing',
  },
  {
    id: 'PAGE-CONNECTORS',
    route: '/settings/connectors',
    source: 'settings/connectors.tsx',
    phase: 'existing',
  },
  { id: 'PAGE-USAGE', route: '/usage', source: 'usage.tsx', phase: 's10' },
  { id: 'PAGE-AUDIT', route: '/audit', source: 'audit.tsx', phase: 's10' },
  {
    id: 'PAGE-API-KEYS',
    route: '/settings/api-keys',
    source: 'settings/api-keys.tsx',
    phase: 's10',
  },
  {
    id: 'PAGE-SYSTEM-STATUS',
    route: '/system/status',
    source: 'system/status.tsx',
    phase: 'existing',
  },
] as const;

export type S11CanonicalPage = (typeof S11_CANONICAL_PAGES)[number];

export function pageSourceExists(page: S11CanonicalPage): boolean {
  return existsSync(join(pagesRoot, page.source));
}

export function existingPageMatrix() {
  return S11_CANONICAL_PAGES.filter((page) => pageSourceExists(page));
}

export function missingPageMatrix() {
  return S11_CANONICAL_PAGES.filter((page) => !pageSourceExists(page));
}

export function phase1UiStatus() {
  const existing = existingPageMatrix();
  const missing = missingPageMatrix();
  return {
    status: missing.length > 0 ? 'BLOCKED' : 'READY',
    existingCount: existing.length,
    expectedPhase1Count: 15,
    finalExpectedCount: 18,
    missing,
    blockers: missing.map((page) => ({
      testId: 'TEST-X-S11-UI-MATRIX',
      pageId: page.id,
      code: 'S10_PAGE_BLOCKED',
    })),
  };
}

export function uiEvidencePath(pageId: string, viewport: string, env = process.env): string {
  const rootDirectory = env.S11_UI_EVIDENCE_DIR?.trim();
  if (!rootDirectory) {
    throw new Error('S11_UI_EVIDENCE_DIR is required for UI screenshots');
  }
  return join(rootDirectory, `${pageId.toLowerCase()}-${viewport}.png`);
}
