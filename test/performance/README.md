# S11 Performance

The performance gate uses k6 only. It never substitutes a Node loop, mock
timer, or historical result.

## Profiles

- `search`: constant arrival rate 50 requests/second for 5 minutes, p95 at or
  below 900 ms, error rate at or below 1%.
- `deep`: constant arrival rate 10 requests/second for 3 minutes, p95 at or
  below 8 seconds, error rate at or below 1%.
- `import`: 10 shared VUs submit 300 independent 20-page PDFs, all Jobs must
  succeed within 60 minutes.

## Commands

```bash
S11_PERF_MODE=probe pnpm test:performance
S11_PERF_MODE=full S11_PERF_PROFILE=standard pnpm test:performance
node test/performance/prepare-fixtures.mjs --profile standard
```

`K6_BIN` must be an absolute executable path when used. Otherwise the runner
searches PATH. Missing k6 prints `PERFORMANCE_K6_UNAVAILABLE` and exits `127`.

The full run requires one million generated Segment records, 300 uploaded
20-page PDFs, `s11-perf-v1`, an isolated workspace, and real AIProxy models.
Its manifest and upload IDs stay outside the worktree under
`S11_EVIDENCE_DIR`.
