# S3 Stage Evidence

## Baseline

- Branch: `feat/kb-s03-catalog-governance`
- Base commit: `dfb35283c7c18365e279a3b3d12bc794cfe749ae`
- Design SHA-256: `8E5E7300C651C4FE0478B87FC3572ADD52F95C3E49C8F15700B45BB8C690A26D`
- Task SHA-256: `BEC0B58D2CC5C1B3434D5B7D54E5C0BA2F9B16354F8FD773F4A8EAA226D1DBE9`
- Plan rules SHA-256: `5923846DD7608A4025E45EA350D77E497682776F9029501D28C7E75967CDAB17`
- No dependency, catalog, lockfile or CI command changes.
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
- Batch execution uses at most 100 unique IDs, exact per-item versions, independent Mongo transactions and ordered 200/207 results.
- Space export uses a real Mongo Job, queued/leased/running terminal states, deterministic directory tree ZIP, manifest in `result`, active ObjectRef and short-lived FileTicket download.
- Reference Binding is persisted in `knowledge_reference_bindings`; upsert/remove increments Space `referenceRevision`, marks old versions stale and removed bindings expire after 30 days.
- Active references block both `block` and `detach` Space deletion until the Registry removes them with a newer revision.
- External Registry behavior is mock-only and is explicitly `EXTERNAL_UNVERIFIED`.
- Business writes and audit are committed in one Mongo transaction; delete Job and `knowledge-delete` Outbox are in the same transaction.
- UI consumes `messageKey + params`, exposes partial/conflict/forbidden/reference-blocked and export job states at 360/768/1200.

## Verification

| Gate                           | Result      |
| ------------------------------ | ----------- |
| `pnpm lint`                    | PASS        |
| `pnpm format:check`            | PASS        |
| `pnpm typecheck`               | PASS        |
| `pnpm openapi:generate`        | PASS, 65/55 |
| `pnpm openapi:check`           | PASS        |
| `pnpm knowledge:inventory`     | PASS        |
| `pnpm knowledge:check-runtime` | PASS        |
| `pnpm test:unit`               | PASS        |
| `pnpm test:contract`           | PASS        |
| `pnpm test:integration`        | PASS        |
| `pnpm test:tenant`             | PASS        |
| `pnpm test:concurrency`        | PASS        |
| `pnpm test:fault`              | PASS        |
| `pnpm test:e2e`                | PASS        |
| `pnpm build`                   | PASS        |
| `pnpm build:workers`           | PASS        |

The final evidence is limited to commands actually executed against the local Mongo replica set, Redis, pgvector and MinIO containers.
