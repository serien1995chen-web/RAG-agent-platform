# S2 Stage Evidence

## Baseline

- Branch: `feat/kb-s02-file-object`
- Stage base commit: `52ccea4d3212cebd05b0a99c84af0301e6605aff`
- Review-fix base commit: `37fcc06cffffa71b482a5570c6600cc506072f9e`
- Plan version: `2.1.0 / S2-REV-01A…07`
- Plan SHA-256: `058EB67274C38EDC87758CB3D7E87A86A980123F9D4E3E45FF3EB08B7A56AD0A`
- Design SHA-256: `8E5E7300C651C4FE0478B87FC3572ADD52F95C3E49C8F15700B45BB8C690A26D`
- Task decomposition SHA-256: `BEC0B58D2CC5C1B3434D5B7D54E5C0BA2F9B16354F8FD773F4A8EAA226D1DBE9`
- Plan Agent rules SHA-256: `5923846DD7608A4025E45EA350D77E497682776F9029501D28C7E75967CDAB17`
- Coding rules SHA-256: `E66934F31C0C4488BDF17CD947879A5B04758C61FA59C107D83321457A966577`
- Dependency installation: user completed `pnpm install`; `pnpm-lock.yaml` is present and its content is accepted as the pnpm-generated baseline.
- No FastGPT source was read or referenced.

## Task Coverage

| Task   | Capability   | Blocking test                           | Local status |
| ------ | ------------ | --------------------------------------- | ------------ |
| S2-T01 | FILE-002     | TEST-FILE-002-BLOCK                     | PASS         |
| S2-T02 | FILE-001     | TEST-FILE-001-BLOCK                     | PASS         |
| S2-T03 | FILE-005     | TEST-FILE-005-BLOCK                     | PASS         |
| S2-T04 | FILE-003     | TEST-FILE-003-BLOCK                     | PASS         |
| S2-T05 | FILE-004     | TEST-FILE-004-BLOCK                     | PASS         |
| S2-T06 | FILE-001…004 | ACC-UI-01…07                            | PASS         |
| S2-T07 | FILE-001…005 | FILE-001…005-BLOCK, SECURITY, IMMUTABLE | PASS         |

## Atomic Steps

| Task   | Plan steps | Count | Status |
| ------ | ---------- | ----: | ------ |
| S2-T01 | S01…S06    |     6 | PASS   |
| S2-T02 | S01…S06    |     6 | PASS   |
| S2-T03 | S01…S03    |     3 | PASS   |
| S2-T04 | S01…S03    |     3 | PASS   |
| S2-T05 | S01…S04    |     4 | PASS   |
| S2-T06 | S01…S03    |     3 | PASS   |
| S2-T07 | S01…S03    |     3 | PASS   |

All 28 Plan atomic steps were executed in dependency order.

## Dependencies

The 13 S2 declarations resolve to the Plan-pinned versions:

- AWS S3 client, lib-storage and request-presigner: `3.1113.0`
- `ali-oss`: `6.23.0`
- `cos-nodejs-sdk-v5`: `3.0.0`
- `es-toolkit`: `1.51.0`
- `mime`: `4.1.0`
- `archiver`: `7.0.1`
- `jszip`: `3.10.1`
- `@types/ali-oss`: `6.23.3`
- `@types/archiver`: `6.0.4`
- `@types/mime-types`: `3.0.1`
- `@types/yauzl`: `2.10.3`

`pnpm list -r --depth 0 --json` completed successfully. Review-fix changes do not modify manifests or `pnpm-lock.yaml`.

## Contract and Runtime

- paths: 92
- operations: 120
- schemas: 139
- parameters: 8
- runtime operations: 58
- deferred operations: 62
- runtime/deferred intersection: 0
- Mongo collections: 23
- vector profiles: 4
- canonical queues: 13
- old page routes: 0

The 12 promoted operations are exactly:

```text
API-UPLOAD-INIT
API-UPLOAD-PRESIGN
API-UPLOAD-PART
API-UPLOAD-COMPLETE
API-UPLOAD-ABORT
API-UPLOAD-GET
API-FILE-PREVIEW
API-FILE-CONTENT
API-FILE-DOWNLOAD
API-SOURCE-PREVIEW
API-SOURCE-DOWNLOAD
API-SOURCE-ARCHIVE
```

## Review Remediation

| Finding    | Implemented evidence                                                                                                                                                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S2-REV-01A | Compression ratio uses bytes actually consumed by deflate, rejects post-EOF padding, and has U14 unit plus real-MinIO completion fixtures.                                                                                                                                             |
| S2-REV-01B | Local CRC and size fields are compared with central metadata; data descriptors are parsed and validated; U18 covers mismatched local metadata and valid/invalid descriptors.                                                                                                           |
| S2-REV-02  | Extension and MIME family are checked; presign uses the declared MIME; size mismatch maps to 413/422, aborts the session and deletes the pending object; U05/U11/U20 pass.                                                                                                             |
| S2-REV-03  | Multipart uses per-part idempotency keys, resumes only missing parts after refresh, refreshes session version before abort, and expired multipart state aborts the provider upload before cleanup.                                                                                     |
| S2-REV-04  | Source access verifies workspace, space, source binding and ObjectRef binding; a mismatched binding returns not-found; integration, tenant and E2E pass.                                                                                                                               |
| S2-REV-05  | All five providers enforce the dual key guard; AWS/R2 use bounded `maxSockets: 50`; COS/OSS/MinIO copy conditions and P10-P12 provider contracts pass.                                                                                                                                 |
| S2-REV-06  | Archive generation streams Source data into the ZIP, persists a pending ObjectRef before upload, inspects before activation, and retains retryable cleanup state on failure; A13-A15 integration/fault evidence passes.                                                                |
| S2-REV-07  | Presigned writes target `pendingKey`; complete conditionally copies to an immutable `finalKey`, rechecks size/ETag/sha256, and activates only the final key. A replayed presigned PUT changes only `pendingKey`; U13/U19 prove the active final object and ticket bytes are unchanged. |

## Blocking Evidence

- `pnpm typecheck`: PASS, 12/12 tasks
- `pnpm lint`: PASS
- `pnpm format:check`: PASS
- `pnpm architecture:check`: PASS
- `pnpm forbidden-files:check`: PASS
- `pnpm openapi:generate`: PASS, 92 paths / 120 operations / 139 schemas / 58 runtime / 62 deferred
- `pnpm openapi:check`: PASS
- `pnpm knowledge:inventory`: PASS, 23 collections / 4 vector profiles / 13 queues
- `pnpm knowledge:check-runtime`: PASS, intersection 0, old page routes 0
- `pnpm test:unit`: PASS, 20/20 tasks; parse 18/18 and web 24/24
- `pnpm test:contract`: PASS, 38/38
- `pnpm test:integration`: PASS, 20/20 tasks; service 40/40 and MinIO 4/4
- `pnpm test:tenant`: PASS, 3/3
- `pnpm test:concurrency`: PASS, 2/2
- `pnpm test:fault`: PASS, 11/11
- `pnpm test:e2e`: PASS, 12/12 across 360/768/1200 viewports
- `pnpm build`: PASS, 12/12 tasks
- `pnpm build:workers`: PASS, 9/9 tasks
- `pnpm license:check`: PASS, with three pre-existing `pending-legal-review` release blockers; no CI blocker
- `pnpm sbom:generate`: PASS
- `docker compose -f deploy/docker-compose.yml config`: PASS
- `docker compose -f deploy/docker-compose.yml ps`: Mongo, Redis, pgvector and MinIO healthy
- `git diff --check`: PASS

The initial unconfigured `pnpm test:integration` run failed before executing two suites because `KB_TEST_MONGO_URI` was absent. Re-running the same command with the CI environment (`.github/workflows/ci.yml`) passed all 20 tasks. This is an environment invocation correction, not a skipped test or changed assertion.

## Provider Verification

| Provider      | Verification                                   | Status                |
| ------------- | ---------------------------------------------- | --------------------- |
| MinIO         | Real Compose, real bucket and network requests | `REAL_VERIFIED`       |
| AWS S3        | Contract and mock only                         | `EXTERNAL_UNVERIFIED` |
| Cloudflare R2 | AWS SDK contract and mock only                 | `EXTERNAL_UNVERIFIED` |
| Tencent COS   | COS SDK contract and mock only                 | `EXTERNAL_UNVERIFIED` |
| Alibaba OSS   | ali-oss contract and mock only                 | `EXTERNAL_UNVERIFIED` |

MinIO image:

```text
registry.cn-hangzhou.aliyuncs.com/fastgpt/minio:RELEASE.2025-09-07T16-13-09Z
sha256:a63b19df59e6ec7c02ebba6e7a1097b7e032da7947b18db7ff67dae8e84fd44d
```

## Scope Guards

- No S3+ Task, path, operation, schema, collection, queue or UI was added.
- No fake success or deferred placeholder is used for the 12 S2 operations.
- Cross-workspace upload, Source binding and ticket replay return safe not-found/forbidden responses.
- Cloud provider mock results are not represented as real cloud integration.
- No push, PR mutation, merge, history rewrite, dependency installation or Docker pull was performed during review remediation.
