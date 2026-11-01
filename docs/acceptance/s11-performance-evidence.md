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

The isolated `s11-perf-v1` app used `KB_ENV=test`, 6000 RPM, 1,100,000
indexes, 50 GiB storage and 10 model concurrency. The usage snapshot returned
profile version
`8eb2c7c8051c1a5c82650f5e0b2435b279377dc4cce231fe7b0dd2d2f3f16498`.
The default `free-v1` profile is unchanged and the test profile is rejected
outside `KB_ENV=test`.

`S11_PERF_FIXTURE_MODE=full node test/performance/prepare-fixtures.mjs --profile standard`
exited `0` with:

```text
PERFORMANCE_FIXTURE_READY
```

Fixture metadata:

```text
pdfCount=300
segmentCount=1000000
segmentCountActual=1000000
seedVerified=true
uploadIdCount=300
quotaProfile=s11-perf-v1
fixtureHash=82b20e68f2eb52d5f0dc2c3b604be348adf1f3cff448fec281a9bb4e9f971cee
```

Independent checks found 300 unique non-empty upload IDs and exactly 1,000,000
Mongo Segments. Upload initialization is paced at four requests per second to
stay below the canonical `API-UPLOAD-INIT` limit of `10 QPS/workspace`; this is
not retry and does not change the route limit.

```text
fixture-manifest.json sha256=132ffae9502f3575aa7824178f6453f87762dd9b7ab6c60bd938c6d3936d247f
upload-ids.json sha256=7ee530e160b1d8ca3fc19c65b7e86715613adf489f66af52a3131fdfbc9e20eb
runtime environment mode=0600
```

## Full Runner

With the verified fixture but no real AIProxy model inputs, the full runner
exited `4`:

```text
PERFORMANCE_PROVIDER_BLOCKED: missing S11_PERF_LLM_MODEL
```

No QPS, percentile, import throughput or bottleneck PASS is claimed. The app
used mock model/OCR/connector modes only to build the local fixture, so these
results are not Provider evidence.

## Required To Unblock

- inject real AIProxy LLM, embedding, rerank, VLM and vision-embedding models;
- load the real Provider values from WSL environment or Secret Manager;
- restart the stack in real Provider mode and run the three k6 scenarios;
- bind the resulting summary to a frozen candidate and rerun recovery/UI gates.
