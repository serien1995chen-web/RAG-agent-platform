import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startB12ImageDeepHarness, type B12ImageDeepHarness } from '../e2e/b12-image-deep-harness';

const root = resolve(import.meta.dirname, '../..');
const steadySeconds = process.env.S11_PERF_DURATION === '10s' ? 10 : 120;
const warmupSeconds = Number(process.env.S11_PERF_WARMUP_SECONDS ?? 30);
const targetQps = Number(process.env.S11_PERF_RATE ?? 20);
const steadyMaxVus = Number(process.env.S11_PERF_STEADY_MAX_VUS ?? 60);

let fixture: B12ImageDeepHarness;

beforeAll(async () => {
  fixture = await startB12ImageDeepHarness();
}, 240_000);

afterAll(async () => {
  await fixture?.close();
});

describe('L1-B12-SEARCH-006 image search performance', () => {
  it('L1-B12-SEARCH-006-Q01 sustains 20 image-search QPS per workspace with p95 at or below 900 ms', async () => {
    const evidenceDir =
      process.env.B12_EVIDENCE_DIR ??
      join(root, 'test-results/b12', `performance-${randomUUID().slice(0, 8)}`);
    mkdirSync(evidenceDir, { recursive: true });
    const tempDir = mkdtempSync(join(tmpdir(), 'b12-image-k6-'));
    const uploadIdsFile = join(tempDir, 'upload-ids.json');
    writeFileSync(uploadIdsFile, `${JSON.stringify([fixture.imageBlobRefId])}\n`);
    const summaryPath = join(evidenceDir, 'b12-image-search-summary.json');
    const stderrPath = join(evidenceDir, 'b12-image-search-k6-stderr.log');
    const scriptPath = join(root, 'test/performance/k6/b12-image-search.js');
    const k6Binary = process.env.K6_BIN?.trim() || 'k6';
    const k6Version = spawnSync(k6Binary, ['version'], { encoding: 'utf8' });
    expect(k6Version.status, k6Version.error?.message ?? k6Version.stderr).toBe(0);
    const result = spawnSync(
      k6Binary,
      [
        'run',
        '--quiet',
        '--summary-export',
        summaryPath,
        '-e',
        `S11_PERF_BASE_URL=${fixture.app.baseUrl}`,
        '-e',
        `S11_PERF_WORKSPACE_ID=${fixture.workspaceId}`,
        '-e',
        `S11_PERF_SPACE_ID=${fixture.spaceId}`,
        '-e',
        `S11_PERF_API_KEY=${fixture.authToken}`,
        '-e',
        `S11_PERF_UPLOAD_IDS_FILE=${uploadIdsFile}`,
        '-e',
        'S11_PERF_QUERY=refund flow diagram',
        scriptPath,
      ],
      {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env },
      },
    );
    writeFileSync(stderrPath, String(result.stderr ?? ''));
    writeFileSync(join(evidenceDir, 'b12-image-search-app.log'), fixture.app.output());
    if (!existsSync(summaryPath)) {
      throw new Error(
        `k6 did not produce a summary (exit=${String(result.status)})\n${String(result.stderr ?? '')}`,
      );
    }

    const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
      metrics: Record<
        string,
        {
          count?: number;
          value?: number;
          rate?: number;
          values?: Record<string, number>;
        }
      >;
    };
    const metricValues = (name: string) => {
      const metric = summary.metrics[name] ?? {};
      return metric.values ?? (metric as Record<string, number>);
    };
    const duration = metricValues('b12_steady_duration');
    const waiting = metricValues('b12_steady_waiting');
    const serverDuration = metricValues('b12_steady_server_duration');
    const failed = metricValues('b12_steady_failed');
    const requests = metricValues('b12_steady_requests');
    const errorRate = failed.rate ?? failed.value;
    const measuredQps = requests.count / steadySeconds;
    const fixtureRoot = join(root, 'test/fixtures/b12');
    const fixtureHash = createHash('sha256');
    for (const name of readdirSync(fixtureRoot).sort()) {
      fixtureHash.update(name);
      fixtureHash.update(readFileSync(join(fixtureRoot, name)));
    }
    const meta = {
      testId: 'L1-B12-SEARCH-006-Q01',
      candidateSha: process.env.CANDIDATE_SHA ?? process.env.GITHUB_SHA ?? 'UNFROZEN',
      k6: k6Version.stdout.trim().split('\n')[0],
      mode: 'deterministic-mock-models-real-infrastructure',
      quotaProfile: process.env.KB_QUOTA_PROFILE ?? 'free-v1',
      queryMode: 'mixed_text_and_image',
      workspaceId: fixture.workspaceId,
      spaceId: fixture.spaceId,
      uploadIdCount: 1,
      fixtureHash: fixtureHash.digest('hex'),
      scenario: {
        executor: 'constant-arrival-rate',
        targetQps,
        warmupSeconds,
        durationSeconds: steadySeconds,
        configuredMaxVus: steadyMaxVus,
        k6ExitCode: result.status,
        p95Ms: duration['p(95)'],
        p95WaitingMs: waiting['p(95)'],
        p95ServerDurationMs: serverDuration['p(95)'],
        errorRate,
        measuredQps,
        requestCount: requests.count,
        completedIterations: metricValues('iterations').count,
        droppedIterations: metricValues('dropped_iterations').count ?? 0,
        maxActiveVus: metricValues('vus_max').max ?? metricValues('vus').max,
        statusCounts: Object.fromEntries(
          Object.entries(summary.metrics)
            .filter(([name]) => name.startsWith('b12_status_'))
            .map(([name, metric]) => [name, metric.count ?? metric.values?.count ?? 0]),
        ),
        errorCodeCounts: Object.fromEntries(
          Object.entries(summary.metrics)
            .filter(([name]) => name.startsWith('b12_error_'))
            .map(([name, metric]) => [name, metric.count ?? metric.values?.count ?? 0]),
        ),
      },
    };
    writeFileSync(
      join(evidenceDir, 'b12-image-search-meta.json'),
      `${JSON.stringify(meta, null, 2)}\n`,
    );
    const markdown = [
      '## B12 image-search performance',
      '',
      `- k6 exit: ${String(result.status)}`,
      `- steady p95: ${String(duration['p(95)'])} ms`,
      `- steady waiting p95: ${String(waiting['p(95)'])} ms`,
      `- server duration p95: ${String(serverDuration['p(95)'])} ms`,
      `- error rate: ${String(errorRate)}`,
      `- measured QPS: ${measuredQps.toFixed(2)}`,
      `- requests: ${String(requests.count)}`,
      `- completed iterations: ${String(meta.scenario.completedIterations)}`,
      `- dropped iterations: ${String(meta.scenario.droppedIterations)}`,
      `- max active VUs: ${String(meta.scenario.maxActiveVus)}`,
      `- configured max VUs: ${String(meta.scenario.configuredMaxVus)}`,
      `- status counts: ${JSON.stringify(meta.scenario.statusCounts)}`,
      `- error code counts: ${JSON.stringify(meta.scenario.errorCodeCounts)}`,
    ].join('\n');
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    }
    console.info(markdown);
    if (result.status !== 0) {
      console.error(String(result.stderr ?? ''));
      console.error(
        `::error title=B12 image-search performance metrics::${JSON.stringify(meta.scenario)}`,
      );
    }

    expect(result.status, `${String(result.stderr ?? '')}\n${JSON.stringify(meta.scenario)}`).toBe(
      0,
    );
    expect(duration['p(95)']).toBeLessThanOrEqual(900);
    expect(errorRate).toBeLessThanOrEqual(0.01);
    expect(
      meta.scenario.droppedIterations,
      'k6 dropped scheduled iterations; the configured VU bound could not sustain the target rate',
    ).toBe(0);
    expect(measuredQps).toBeGreaterThanOrEqual(18);
  }, 210_000);
});
