import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface FixtureManifest {
  segmentCount?: number;
  segmentCountActual?: number;
  seedVerified?: boolean;
  fixtureHash?: string;
  recallAt10?: number;
}

const manifestPath = process.env.B16_A_PERF_FIXTURE_MANIFEST?.trim();
const summaryPath = process.env.B16_A_PERF_SUMMARY?.trim();
const performanceInputsAvailable = Boolean(
  manifestPath && summaryPath && existsSync(manifestPath) && existsSync(summaryPath),
);
const blockedReason = !manifestPath
  ? 'verified 1M fixture manifest is missing'
  : !existsSync(manifestPath)
    ? 'verified 1M fixture manifest is unreadable'
    : !summaryPath
      ? 'k6 summary is missing'
      : !existsSync(summaryPath)
        ? 'k6 summary is unreadable'
        : null;

if (blockedReason) {
  console.warn(`B16_PERF_BLOCKED_ENV: ${blockedReason}`);
}

describe.skipIf(!performanceInputsAvailable)('B16 codexA formal search performance gate', () => {
  it('L1-B16-A-SEARCH-001-Q01 requires real 1M Segments, 50 QPS, p95<=900ms and Recall@10=100%', () => {
    const manifest = JSON.parse(readFileSync(manifestPath!, 'utf8')) as FixtureManifest;
    const summary = JSON.parse(readFileSync(summaryPath!, 'utf8')) as {
      scenarios?: {
        search?: {
          qps?: number;
          p95Milliseconds?: number;
          failureRatePercent?: number;
          recallAt10Percent?: number;
        };
      };
      hardware?: unknown;
      runtime?: unknown;
      fixtureHash?: string;
    };
    expect(manifest).toMatchObject({
      segmentCount: 1_000_000,
      segmentCountActual: 1_000_000,
      seedVerified: true,
      recallAt10: 1,
    });
    expect(summary.fixtureHash).toBe(manifest.fixtureHash);
    expect(summary.hardware).toBeTruthy();
    expect(summary.runtime).toBeTruthy();
    expect(summary.scenarios?.search).toMatchObject({
      qps: 50,
    });
    expect(summary.scenarios?.search?.p95Milliseconds).toBeLessThanOrEqual(900);
    expect(summary.scenarios?.search?.failureRatePercent).toBeLessThanOrEqual(1);
    expect(summary.scenarios?.search?.recallAt10Percent).toBe(100);
  });
});
