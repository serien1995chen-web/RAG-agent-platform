# S11 Performance Evidence

Result: `SCOPED_BLOCKED`.

Candidate: not frozen.

## Probe

`S11_PERF_MODE=probe S11_PERF_BASE_URL=http://127.0.0.1:3010 pnpm test:performance`
exited `0` with:

```text
k6 v2.3.0 (commit/e088784614, go1.26.8, linux/amd64)
PERFORMANCE_READY
```

The local app `/healthz` and `/readyz` returned `200`.

## Full Fixture

`node test/performance/prepare-fixtures.mjs --profile standard` generated 300
PDF copies and a deterministic fixture hash, then exited `3`:

```text
PERFORMANCE_FIXTURE_BLOCKED: 300 upload IDs and 1,000,000 seeded Segments are required
```

Fixture metadata:

```text
pdfCount=300
segmentCount=1000000
segmentCountActual=0
seedVerified=false
uploadIdCount=0
quotaProfile=s11-perf-v1
```

The full runner rejects this manifest with exit `5`:

```text
PERFORMANCE_FIXTURE_FAILED: segment_count_1m_required,segment_seed_unverified,upload_ids_file_missing
```

No QPS, percentile, throughput or bottleneck PASS is claimed.

The full fixture path is implemented behind `S11_PERF_FIXTURE_MODE=full`. It
uses the canonical Upload API for 300 PDFs, creates the isolated Space and S10
API key when required, writes a mode-`0600` runtime env outside the worktree,
and seeds `knowledge_segments` inside the Mongo container. Running full mode
without its external inputs exits `1` with a missing-variable error rather than
producing a fixture.

## Required To Unblock

- operator-created isolated workspace, Space and API key;
- 300 unique uploaded 20-page PDF IDs;
- a verified 1,000,000 Segment seed;
- real AIProxy models and an available app/worker stack;
- external `S11_EVIDENCE_DIR`.
