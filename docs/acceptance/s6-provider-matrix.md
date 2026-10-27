# S6 Provider Matrix

## Candidate

- Candidate SHA: `c398593db550e6d4832a24642b368f11bac22ff8`.
- Branch: `feat/kb-s06-job-index`.
- Conclusion scope: S6 branch only.

## Matrix

| Dependency or capability                           | Status                | Evidence boundary                                              |
| -------------------------------------------------- | --------------------- | -------------------------------------------------------------- |
| MongoDB replica-set transaction and tenant filters | `REAL_VERIFIED`       | integration, tenant, concurrency and fault suites              |
| Redis and BullMQ                                   | `REAL_VERIFIED`       | real Outbox -> import/parse/index workers; 13 ready consumers  |
| PostgreSQL / pgvector                              | `REAL_VERIFIED`       | 768, 1024, 1536 and 3072 profiles; 3072 uses `halfvec`         |
| MinIO source artifacts                             | `REAL_VERIFIED`       | S2/S3/S5 suites and S6 parse artifact materialization          |
| S5 parse / chunk / QA code path                    | `FIXTURE_VERIFIED`    | deterministic local parse fixture, existing S5 functions       |
| S5 embedding gateway                               | `MOCK_PASS`           | deterministic mock embedding, real normalization and PG writes |
| External OCR provider                              | `EXTERNAL_UNVERIFIED` | no production credentials or provider response                 |
| External LLM / embedding provider                  | `EXTERNAL_UNVERIFIED` | mock model catalog and gateway only                            |
| External connector providers                       | `EXTERNAL_UNVERIFIED` | deterministic provider fixture only                            |
| S4 connector sync submission                       | `FIXTURE_VERIFIED`    | connector Job handoff without pre-created Source payload       |
| S6 connector sync discovery                        | `FIXTURE_VERIFIED`    | deterministic provider pagination/content, real Mongo/MinIO    |
| S6 connector cursor and completion CAS             | `REAL_VERIFIED`       | cursorVersion/changeSet checkpoint and terminal root handoff   |
| S6 connector failure retry/replay                  | `REAL_VERIFIED`       | failed -> syncing Job CAS and active terminal recovery         |
| S8 caption executor                                | `OUT_OF_SCOPE`        | controlled dependency failure, never fake success              |
| S7 search, RRF, rerank, citation                   | `DEFERRED`            | runtime remains `0` in the S6 branch                           |
| Compose app/worker image release                   | `NOT_RELEASED`        | local build and local worker smoke only                        |

## Worker Smoke

The final bundled worker was started against real Mongo, Redis, PostgreSQL and
MinIO. It produced the readiness marker only after all 13 consumers were ready.

```text
knowledge-caption
knowledge-cleanup
knowledge-delete
knowledge-embed
knowledge-import
knowledge-index
knowledge-ocr
knowledge-outbox
knowledge-parse
knowledge-qa
knowledge-rebuild
knowledge-segment
knowledge-sync
```

Observed results:

- Redis meta keys: `13 / 13`.
- Readiness marker: `ready`.
- `SIGTERM`: marker removed and process exited `0`.
- Missing required secret configuration: process exited non-zero and readiness
  marker stayed absent.

## Caveats

- Connector discovery is verified with deterministic Feishu pagination/content
  and real Mongo/MinIO transactions. Production connector credentials remain
  external-unverified.
- Optional PDF canvas warnings were emitted by the bundled worker, but worker
  readiness, shutdown and all required gates passed.
- Five license release blockers remain pending legal review as documented in
  `s6-dependency-ledger.md`.

## Conclusion

Provider state is suitable for an S6 branch gate with explicit mock and external
boundaries. It is not evidence of production provider availability or W2 final
completion.
