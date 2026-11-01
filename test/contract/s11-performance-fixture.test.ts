import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertIsolatedTarget } from '../../test/performance/prepare-fixtures.mjs';
import { validateFullFixture } from '../../scripts/run-performance.mjs';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureDirectory(uploadIds: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 's11-performance-fixture-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'upload-ids.json');
  writeFileSync(path, `${JSON.stringify(uploadIds)}\n`);
  return path;
}

function manifest(uploadIdsFile: string) {
  return {
    segmentCount: 1_000_000,
    segmentCountActual: 1_000_000,
    seedVerified: true,
    pdfCount: 300,
    uploadIdsFile,
  };
}

describe('TEST-X-PERF-SEARCH / TEST-X-PERF-IMPORT fixture validation', () => {
  it('requires an exact kb_s11_ prefix', () => {
    expect(assertIsolatedTarget('kb_s11_performance')).toBe('kb_s11_performance');
    expect(() => assertIsolatedTarget('copy-kb_s11_performance')).toThrow('start with');
    expect(() => assertIsolatedTarget('performance')).toThrow('start with');
  });

  it('accepts only 300 unique upload IDs and a verified 1M seed', () => {
    const ids = Array.from({ length: 300 }, (_, index) => `upload-${index}`);
    expect(validateFullFixture(manifest(fixtureDirectory(ids)), {})).toEqual([]);
    expect(
      validateFullFixture(manifest(fixtureDirectory([...ids.slice(0, 299), ids[0]])), {}),
    ).toContain('upload_ids_invalid_or_duplicate');
    expect(validateFullFixture(manifest(fixtureDirectory(ids.slice(0, 299))), {})).toContain(
      'upload_ids_count_mismatch',
    );
    expect(
      validateFullFixture(
        {
          ...manifest(fixtureDirectory(ids)),
          segmentCountActual: 0,
          seedVerified: false,
        },
        {},
      ),
    ).toEqual(expect.arrayContaining(['segment_count_1m_required', 'segment_seed_unverified']));
  });
});
