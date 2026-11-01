const STANDARD_THRESHOLDS = Object.freeze({
  searchP95Ms: 900,
  deepP95Ms: 8_000,
  importFilesPerHour: 300,
  maxErrorRate: 0.01,
});

function numeric(value, fallback = null) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function metricValues(summary, name) {
  const metric = summary?.metrics?.[name];
  return metric?.values ?? metric ?? {};
}

export function normalizeK6Scenario(summary, input) {
  const duration = metricValues(summary, 'http_req_duration');
  const failed = metricValues(summary, 'http_req_failed');
  const requests = metricValues(summary, 'http_reqs');
  const p50Ms = numeric(duration['p(50)'] ?? duration.med);
  const p95Ms = numeric(duration['p(95)']);
  const p99Ms = numeric(duration['p(99)']);
  const errorRate = numeric(failed.rate);
  const qps = numeric(requests.rate);
  const importFailed = metricValues(summary, 's11_import_failed').rate;
  const files = input.kind === 'import' ? input.files : null;
  const elapsedSeconds = input.kind === 'import' ? input.elapsedSeconds : null;
  const filesPerHour =
    input.kind === 'import' && elapsedSeconds && elapsedSeconds > 0
      ? Number(((files * 3_600) / elapsedSeconds).toFixed(3))
      : null;
  return {
    kind: input.kind,
    qps,
    p50Ms,
    p95Ms,
    p99Ms,
    errorRate:
      input.kind === 'import' && typeof importFailed === 'number'
        ? importFailed > 0
          ? 1
          : 0
        : errorRate,
    files,
    pagesPerFile: input.kind === 'import' ? input.pagesPerFile : null,
    parseConcurrency: input.kind === 'import' ? input.parseConcurrency : null,
    elapsedSeconds,
    filesPerHour,
    bottleneck: input.bottleneck ?? 'none',
  };
}

export function validateThresholds(scenarios) {
  const blockers = [];
  if ((scenarios.search?.p95Ms ?? Infinity) > STANDARD_THRESHOLDS.searchP95Ms) {
    blockers.push('search_p95');
  }
  if ((scenarios.search?.errorRate ?? Infinity) > STANDARD_THRESHOLDS.maxErrorRate) {
    blockers.push('search_error_rate');
  }
  if ((scenarios.deep?.p95Ms ?? Infinity) > STANDARD_THRESHOLDS.deepP95Ms) {
    blockers.push('deep_p95');
  }
  if ((scenarios.deep?.errorRate ?? Infinity) > STANDARD_THRESHOLDS.maxErrorRate) {
    blockers.push('deep_error_rate');
  }
  if ((scenarios.import?.filesPerHour ?? 0) < STANDARD_THRESHOLDS.importFilesPerHour) {
    blockers.push('import_files_per_hour');
  }
  if ((scenarios.import?.errorRate ?? Infinity) > 0) {
    blockers.push('import_job_failures');
  }
  return {
    status: blockers.length === 0 ? 'PASS' : 'FAIL',
    blockers,
    thresholds: STANDARD_THRESHOLDS,
  };
}

export function normalizePerformanceResult(input) {
  const threshold = validateThresholds(input.scenarios);
  return {
    candidateSha: input.candidateSha,
    profile: input.profile,
    fixtureHash: input.fixtureHash,
    hardware: input.hardware,
    runtime: input.runtime,
    models: input.models,
    scenarios: input.scenarios,
    status: threshold.status,
    blockers: threshold.blockers,
    thresholds: threshold.thresholds,
  };
}
