import { describe, expect, it } from 'vitest';
import {
  S11_CANONICAL_PAGES,
  S11_VIEWPORTS,
  existingPageMatrix,
  missingPageMatrix,
  pageSourceExists,
  phase1UiStatus,
} from './s11-ui-matrix.fixture';

describe('TEST-X-S11-UI-MATRIX', () => {
  it('lists 18 canonical pages and exactly 15 existing phase1 pages', () => {
    expect(S11_CANONICAL_PAGES).toHaveLength(18);
    expect(existingPageMatrix()).toHaveLength(15);
    expect(missingPageMatrix().map((page) => page.id)).toEqual([
      'PAGE-USAGE',
      'PAGE-AUDIT',
      'PAGE-API-KEYS',
    ]);
    for (const page of existingPageMatrix()) expect(pageSourceExists(page), page.id).toBe(true);
  });

  it('uses three fixed viewports and reports S10 pages as BLOCKED, not mocked', () => {
    expect(S11_VIEWPORTS.map((viewport) => viewport.width)).toEqual([360, 768, 1200]);
    expect(phase1UiStatus()).toMatchObject({
      status: 'BLOCKED',
      existingCount: 15,
      expectedPhase1Count: 15,
      finalExpectedCount: 18,
    });
    expect(phase1UiStatus().blockers).toHaveLength(3);
  });

  it('does not expose Deferred routes in the phase1 matrix', () => {
    const routes = existingPageMatrix().map((page) => page.route);
    expect(routes).not.toContain('/usage');
    expect(routes).not.toContain('/audit');
    expect(routes).not.toContain('/settings/api-keys');
  });
});
