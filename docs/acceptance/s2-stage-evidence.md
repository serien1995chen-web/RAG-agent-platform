# S2 Stage Evidence

## Baseline

- Branch: `feat/kb-s02-file-object`
- Base commit: `52ccea4d3212cebd05b0a99c84af0301e6605aff`
- Plan SHA-256: `2EF6230266B156BA11624B839702A6B44AC2A0D9ADE0D17CCE46DC99D6016783`
- Design SHA-256: `8E5E7300C651C4FE0478B87FC3572ADD52F95C3E49C8F15700B45BB8C690A26D`
- Task decomposition SHA-256: `BEC0B58D2CC5C1B3434D5B7D54E5C0BA2F9B16354F8FD773F4A8EAA226D1DBE9`
- Coding rules SHA-256: `E66934F31C0C4488BDF17CD947879A5B04758C61FA59C107D83321457A966577`

## Task Coverage

| Task   | Capability   | Blocking test           | Status |
| ------ | ------------ | ----------------------- | ------ |
| S2-T01 | FILE-002     | TEST-FILE-002-BLOCK     | PASS   |
| S2-T02 | FILE-001     | TEST-FILE-001-BLOCK     | PASS   |
| S2-T03 | FILE-005     | TEST-FILE-005-BLOCK     | PASS   |
| S2-T04 | FILE-003     | TEST-FILE-003-BLOCK     | PASS   |
| S2-T05 | FILE-004     | TEST-FILE-004-BLOCK     | PASS   |
| S2-T06 | FILE-001…004 | ACC-UI-01…07            | PASS   |
| S2-T07 | FILE-001…005 | TEST-FILE-001…005-BLOCK | PASS   |

All 25 Plan atomic steps were executed in the fixed dependency order.

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

The 12 promoted operations are limited to the S2 allowlist in the Plan.

## S2-REV-01 Compression Safety

- Unified inspector: `packages/parse/src/archive-safety.ts`
- Upload completion wiring: `FileApplication.complete`
- Generated archive wiring: `KnowledgeArchiveWorker.processJob`
- Runtime adapter: `projects/app/src/runtime/archive-safety.adapter.ts`
- Trigger: inner ZIP magic, independent of filename
- Containers: ZIP, DOCX, PPTX, XLSX, EPUB
- Upload entry limit: 2000
- Generated archive limit: 2000 Source entries plus exactly one `manifest.json`
- Declared and actual uncompressed total: 2048 MiB
- Single entry: 512 MiB
- Entry and total compression ratio: 100:1
- Central directory: 16 MiB
- Range read: 1 MiB maximum
- Decompression accounting chunk: 64 KiB
- Inspection deadline: 30000 ms
- Path checks: traversal, absolute path, drive prefix, UNC, backslash, NUL, empty segment, duplicate NFC/case-fold path, file/directory conflict
- Structure checks: central directory bounds, local header offset, range overlap, compressed/uncompressed size, CRC32, encryption, special entry, compression method
- Unsafe upload: provider object deleted, UploadSession non-active
- Unsafe archive: pending provider object deleted, Job failed, no active ObjectRef
- `TEST-FILE-001-U13` through `U19`: PASS
- `TEST-FILE-004-A08` and `A13` through `A17`: PASS
- `TEST-X-SECURITY-UPLOAD`: PASS

## Blocking Evidence

- `pnpm test:unit`: PASS, 20/20 tasks; parse archive-safety 18/18 tests
- `pnpm test:contract`: PASS
- `pnpm test:integration`: PASS with real Mongo, Redis, pgvector and MinIO; service 28/28 tests
- `pnpm test:tenant`: PASS
- `pnpm test:concurrency`: PASS
- `pnpm test:fault`: PASS, 10 tests
- `pnpm test:e2e`: PASS, 11 tests, 360/768/1200 viewports, axe serious/critical 0, console/page errors 0
- `pnpm build`: PASS
- `pnpm build:workers`: PASS

MinIO upload coverage includes bucket creation, single PUT, presign GET, two-part 8 MiB multipart completion, HEAD/ETag equality, abort replay, delete 404 idempotency, and bytes=10-19 Range.

Archive coverage builds a real ZIP object and records an active export ObjectRef with a three-hour TTL.

Compression safety coverage includes valid ZIP/OOXML/EPUB containers, ratio bombs, path traversal, duplicate and special entries, entry-count and size limits, damaged central directories, CRC mismatch, overlapping ranges, inspector deadlines and provider range failures. Unsafe generated archives are rejected before `createArchiveArtifact`.

## Scope Guards

- No FastGPT source was read or referenced.
- No S3+ Task, path, operation, schema, collection, queue or UI was added.
- No fake success or deferred placeholder is used for the 12 S2 operations.
- Cross-workspace upload and ticket replay return safe not-found/forbidden responses.
