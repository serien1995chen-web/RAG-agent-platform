# S10 Cleanup, Reconcile And Replay Acceptance

## Status

- Task: `S10-T04`
- Candidate: `319dbd4bf9b5e3a956c475beb8a1c950fcb47cd2`
- Result: `PASS`

## Delivered

- Existing `knowledge-cleanup` and `knowledge-outbox` queues are reused; no new
  collection or queue was added.
- Cleanup scopes: `ttl_objects`, `orphan_objects`, `orphan_vectors`, `stale_jobs`,
  `all`.
- Reconcile scopes: `objects`, `vectors`, `fulltext`, `outbox`, `all`.
- Jobs carry stable batch keys, bounded batches, step evidence, retry/dead-letter
  state and version CAS.
- Outbox replay accepts only failed/dead-letter events at the supplied version.
- BullMQ receives canonical `k_...` keys while the payload retains the Mongo Job ID.
- Stale `publishing` events are recovered using the same BullMQ key, preventing a
  crash between enqueue and status update from creating a second final publish.

## Blocking Evidence

| Test ID                     | Result | Evidence                                                             |
| --------------------------- | ------ | -------------------------------------------------------------------- |
| `TEST-OPS-004-BLOCK`        | PASS   | `s10-ops.test.ts`, S10 E2E cleanup Job response                      |
| `TEST-X-PGVECTOR-PARTIAL`   | PASS   | `test/fault/s10-ops-fault.test.ts`, retryable partial-vector failure |
| `TEST-X-OUTBOX-CRASH`       | PASS   | `s5-usage-outbox.test.ts`, stale publishing recovery                 |
| `TEST-S10-REPLAY-CAS`       | PASS   | one concurrent replay winner in `s10-ops.test.ts`                    |
| `TEST-S10-NO-FAKE-COMPLETE` | PASS   | dependency failure never commits success                             |

## Commands

- `pnpm test:integration`: exit 0, service 33 files / 179 tests.
- `pnpm test:concurrency`: exit 0, 10 files / 21 tests.
- `pnpm test:fault`: exit 0, 12 files / 38 tests.
- `pnpm test:e2e`: cleanup submission returns and displays a real 24-hex Job ID.

## Risks

- Repair behavior depends on real S3/PGVector permissions. The S10 local gate
  proves retry and no-fake-success semantics; final provider certification belongs
  to S11/W4.
