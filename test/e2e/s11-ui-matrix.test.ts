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
  it('lists all product pages after the FastGPT product migration', () => {
    expect(S11_CANONICAL_PAGES).toHaveLength(14);
    expect(existingPageMatrix()).toHaveLength(14);
    expect(missingPageMatrix()).toEqual([]);
    for (const page of existingPageMatrix()) expect(pageSourceExists(page), page.id).toBe(true);
  });

  it('uses three fixed viewports and exposes all product pages', () => {
    expect(S11_VIEWPORTS.map((viewport) => viewport.width)).toEqual([360, 768, 1200]);
    expect(phase1UiStatus()).toMatchObject({
      status: 'READY',
      existingCount: 14,
      expectedPhase1Count: 14,
      finalExpectedCount: 14,
    });
    expect(phase1UiStatus().blockers).toHaveLength(0);
  });

  it('has a unique canonical route for every page', () => {
    const routes = existingPageMatrix().map((page) => page.route);
    expect(new Set(routes).size).toBe(routes.length);
    expect(routes).toEqual(expect.arrayContaining(['/dataset/list', '/dataset/detail']));
    for (const retiredRoute of [
      '/usage',
      '/audit',
      '/settings/api-keys',
      '/settings/connectors',
      '/system/status',
    ]) {
      expect(routes).not.toContain(retiredRoute);
    }
  });
});
