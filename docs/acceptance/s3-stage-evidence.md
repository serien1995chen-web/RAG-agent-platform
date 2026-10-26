# S3 Stage Evidence

## Baseline

- Branch: `feat/kb-s03-catalog-governance`
- Base commit: `dfb35283c7c18365e279a3b3d12bc794cfe749ae`
- Design SHA-256: `8E5E7300C651C4FE0478B87FC3572ADD52F95C3E49C8F15700B45BB8C690A26D`
- Task SHA-256: `BEC0B58D2CC5C1B3434D5B7D54E5C0BA2F9B16354F8FD773F4A8EAA226D1DBE9`
- Plan rules SHA-256: `5923846DD7608A4025E45EA350D77E497682776F9029501D28C7E75967CDAB17`
- No dependency, catalog, lockfile or CI command changes.
- `packages/parse/src/archive-safety.ts` has no net diff against `origin/main`; Space ZIP uses the ordinary ZIP safety adapter instead of changing Parse core behavior.
- Runtime/deferred counts are derived from the generated contract and approved runtime registry rather than hard-coded stage numbers.
- FastGPT was read only for export behavior at `D:\Fastgpt\FastGPT`; no source, naming, schema, prompt or page was copied.

## Task Coverage

| Task   | Capability | Operations                                                | Status |
| ------ | ---------- | --------------------------------------------------------- | ------ |
| S3-T01 | KB-003     | `API-SPACE-MOVE`, `API-DIRECTORY-MOVE`, `API-SOURCE-MOVE` | PASS   |
| S3-T02 | KB-003     | `API-SPACE-BATCH`, `API-SOURCE-BATCH`                     | PASS   |
| S3-T03 | KB-003     | `API-SPACE-EXPORT`                                        | PASS   |
| S3-T04 | KB-003     | `API-SPACE-REFERENCES`                                    | PASS   |
| S3-T05 | KB-003     | Audit and required Outbox transactions                    | PASS   |
| S3-T06 | KB-003     | Move, batch, export and reference UI                      | PASS   |
| S3-T07 | KB-003     | Stage regression                                          | PASS   |

## Contract and Runtime

- paths: 92
- operations: 120
- schemas: 139
- parameters: 8
- runtime operations: 65
- deferred operations: 55
- runtime/deferred intersection: 0
- Mongo collections: 23
- vector profiles: 4
- canonical queues: 13
- old page routes: 0

The 7 promoted S3 operations are:

```text
API-SPACE-MOVE
API-SPACE-BATCH
API-SPACE-EXPORT
API-SPACE-REFERENCES
API-DIRECTORY-MOVE
API-SOURCE-MOVE
API-SOURCE-BATCH
```

## Implemented Evidence

- Move uses expected-version CAS, tenant-scoped parent lookup, ObjectId `parentPath`, cycle detection and a maximum depth of 4.
- Directory move atomically rewrites the complete subtree path/depth/version.
- Database tests cover Space/Directory self and descendant cycles, depth 5, sibling-name conflicts, Directory/Source tenant isolation and Directory/Source same-version races.
- Batch execution uses at most 100 unique IDs, exact per-item versions, independent Mongo transactions and ordered 200/207 results.
- Batch tests cover 0/1/100/101 boundaries, duplicate IDs, exact version maps, HTTP idempotency replay/conflict and successful items surviving an independent item failure.
- Batch move validates the common non-null target folder/directory `write` permission before item execution; Source Batch keeps resource permission, version and transaction failures itemized.
- Space export uses a real Mongo Job, queued/leased/running terminal states, deterministic directory tree ZIP, manifest in `result`, active ObjectRef and short-lived FileTicket download.
- Space Export tests verify the 2000/2001 API limit, duplicate archive names, metadata-only Sources, ObjectRef HEAD/size/MIME, ticket download, ticket expiry and cross-workspace isolation.
- Retryable Export Jobs are atomically requeued from `retry_wait` by the worker after the backoff time; tests no longer mutate the database to simulate recovery.
- Reference Binding is persisted in `knowledge_reference_bindings`; upsert/remove increments Space `referenceRevision`, marks old versions stale and removed bindings expire after 30 days.
- Active references block both `block` and `detach` Space deletion until the Registry removes them with a newer revision.
- External Registry behavior is mock-only and is explicitly `EXTERNAL_UNVERIFIED`.
- Business writes and audit are committed in one Mongo transaction; delete Job and `knowledge-delete` Outbox are in the same transaction.
- UI consumes `messageKey + params`, exposes partial/conflict/forbidden/reference-blocked and export job states at 360/768/1200.
- Browser evidence covers queued, running, succeeded and failed Export states at 360/768/1200 with axe and overflow assertions.
- Move Idempotency-Key is reset when the target changes or a non-network 4xx is returned, while retryable network/server failures keep the key for a true replay.

## Review Remediation

| Issue  | Resolution                                                                                                                                     | Evidence                                                                          |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| S3-R01 | Restored Parse core to zero diff vs main; promoted Space ZIP through the ordinary ZIP adapter; removed hard-coded stage counts.                | Parse diff check, `knowledge:inventory`, `knowledge:check-runtime`, worker build. |
| S3-R02 | Added common target write-permission checks for Space and Source Batch Move.                                                                   | `TEST-KB-003-BLOCK` integration target-ACL case.                                  |
| S3-R03 | Moved Source Batch permission, source read and version checks into per-item handling so mixed success returns ordered 207.                     | Source Batch integration assertions for success persistence and failed audit.     |
| S3-R04 | Made batch `versions` required, IDs unique and version maps bounded; documented Export 413 and corrected ZIP examples.                         | Contract tests and OpenAPI generation/check.                                      |
| S3-R05 | Added CAS-based `retry_wait` to `queued` requeue before worker claims.                                                                         | Archive integration retry test and `build:workers`.                               |
| S3-R06 | Added Reference stale/replay/revision/TTL/tenant coverage, audit and Outbox rollback cases, UI state assertions and real browser S3 scenarios. | Unit, integration, tenant, concurrency, fault and E2E suites.                     |
| S3-R07 | Rotated Move idempotency keys on target changes and business 4xx failures; exposed active-reference deletion blocking.                         | Web unit test and S3 E2E scenario.                                                |
| S3-R08 | Added the complete database Move matrix for Space/Directory/Source tenant, concurrency, cycle, depth and sibling-name cases.                   | Integration, tenant and concurrency suites; zero-write assertions.                |
| S3-R09 | Added Batch 0/100/101, duplicate/version, idempotency and independent-item failure coverage.                                                   | Contract, integration, concurrency, fault and E2E suites.                         |
| S3-R10 | Added real Space Export artifact, ticket, tenant, name-collision, metadata-only and 2000-limit coverage.                                       | Archive integration, tenant and fault suites.                                     |
| S3-R11 | Added three-viewport Export lifecycle evidence with committed screenshots, axe and overflow checks.                                            | E2E suite and `docs/acceptance/s3-ui/*.png`.                                      |

## UI Evidence

| Viewport | Screenshot                                   |
| -------- | -------------------------------------------- |
| 360px    | `docs/acceptance/s3-ui/s3-overview-360.png`  |
| 768px    | `docs/acceptance/s3-ui/s3-overview-768.png`  |
| 1200px   | `docs/acceptance/s3-ui/s3-overview-1200.png` |

## Verification

| Gate                           | Result                                                 |
| ------------------------------ | ------------------------------------------------------ |
| `pnpm lint`                    | PASS                                                   |
| `pnpm format:check`            | PASS                                                   |
| `pnpm typecheck`               | PASS                                                   |
| `pnpm openapi:generate`        | PASS, 92/120/139/8, runtime 65/deferred 55             |
| `pnpm openapi:check`           | PASS                                                   |
| `pnpm knowledge:inventory`     | PASS                                                   |
| `pnpm knowledge:check-runtime` | PASS                                                   |
| `pnpm test:unit`               | PASS, 20/20 tasks                                      |
| `pnpm test:contract`           | PASS, 40/40 tests                                      |
| `pnpm test:integration`        | PASS, 20/20 tasks; Service 57/57 tests                 |
| `pnpm test:tenant`             | PASS, 8/8 tests                                        |
| `pnpm test:concurrency`        | PASS, 8/8 tests                                        |
| `pnpm test:fault`              | PASS, 15/15 tests                                      |
| `pnpm test:e2e`                | PASS, 20/20 tests                                      |
| `pnpm build`                   | PASS                                                   |
| `pnpm build:workers`           | PASS                                                   |
| `pnpm architecture:check`      | PASS                                                   |
| `pnpm forbidden-files:check`   | PASS                                                   |
| `pnpm license:check`           | PASS with documented release blockers; CI non-blocking |
| `pnpm sbom:generate`           | PASS                                                   |
| Compose config/ps              | PASS; Mongo, Redis, pgvector and MinIO healthy         |
| `git diff --check`             | PASS                                                   |

The final evidence is limited to commands actually executed against the local Mongo replica set, Redis, pgvector and MinIO containers on 2026-10-26.
