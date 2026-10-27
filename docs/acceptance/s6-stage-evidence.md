# S6 Stage Evidence

## Status

- Wave: `W2`.
- Stage: `S6 / personB`.
- Branch: `feat/kb-s06-job-index`.
- Candidate SHA: `e8df687c671fe880a72dd2f1e66eee8ddfcd6202`.
- Evidence commit SHA: `EVIDENCE_DOCS_ONLY_COMMIT`, recorded exactly in the final
  delivery report.
- W2 baseline: `87ba3bdea3d7daf3e738a04998b80b49cbf7a77b`.
- W1 runtime baseline: `83 / 37`.
- S6 runtime result: `95 / 25`.
- W2 final target: `100 / 20`, not run in S6.
- Branch conclusion: `S6_BRANCH_PASS_PENDING_S7`.

No personA candidate SHA or S6 merge SHA was supplied. W2 personB was not run and
W2 is not claimed complete.

## Scope

Tasks:

```text
S6-T01 S6-T02 S6-T03 S6-T04 S6-T05
S6-T06 S6-T07 S6-T08 S6-T09
```

Capabilities:

```text
COL-002
DATA-002 DATA-003 DATA-004
TRAIN-001 TRAIN-002 TRAIN-003 TRAIN-004 TRAIN-005 TRAIN-007
```

S6 runtime operations:

```text
API-JOB-CREATE
API-JOB-RETRY
API-JOB-CANCEL
API-JOB-PAUSE
API-JOB-RESUME
API-JOB-REPLAY
API-SEGMENT-BATCH
API-SEGMENT-INDEX-CREATE
API-SEGMENT-INDEX-UPDATE
API-SEGMENT-INDEX-DELETE
API-SEGMENT-HISTORY
API-SEGMENT-REINDEX
```

S7 operations remain deferred. Search, RRF, rerank, citation, Search UI and DOWN
operations were not implemented.

## Contract And Runtime

| Check                           | Result    |
| ------------------------------- | --------- |
| Paths                           | `92`      |
| Operations                      | `120`     |
| Schemas                         | `139`     |
| Parameters                      | `8`       |
| Runtime                         | `95`      |
| Deferred                        | `25`      |
| Runtime / deferred intersection | `0`       |
| Runtime / deferred union        | `120`     |
| S6 runtime operations           | `12 / 12` |
| S7 runtime operations           | `0 / 5`   |
| Canonical queues                | `13`      |
| Mongo collections               | `23`      |
| Vector profiles                 | `4`       |

## Command Matrix

All commands were run on candidate SHA
`e8df687c671fe880a72dd2f1e66eee8ddfcd6202` with the real local infrastructure
environment and exited `0`.

| Gate                           | Result                                        |
| ------------------------------ | --------------------------------------------- |
| `pnpm lint`                    | PASS                                          |
| `pnpm format:check`            | PASS                                          |
| `pnpm typecheck`               | PASS, 12 packages                             |
| `pnpm architecture:check`      | PASS, 98 service sources                      |
| `pnpm forbidden-files:check`   | PASS, 413 files                               |
| `pnpm test:unit`               | PASS, Turbo 21/21                             |
| `pnpm test:contract`           | PASS, 79 tests                                |
| `pnpm test:integration`        | PASS, Turbo 21/21; service 112 tests          |
| `pnpm test:tenant`             | PASS, 12 tests                                |
| `pnpm test:concurrency`        | PASS, 13 tests                                |
| `pnpm test:fault`              | PASS, 25 tests                                |
| `pnpm test:e2e`                | PASS, 37 tests                                |
| `pnpm build`                   | PASS, 12/12                                   |
| `pnpm build:workers`           | PASS, 10/10                                   |
| `pnpm openapi:generate`        | PASS                                          |
| `pnpm openapi:check`           | PASS                                          |
| `pnpm knowledge:inventory`     | PASS                                          |
| `pnpm knowledge:check-runtime` | PASS                                          |
| `pnpm license:check`           | PASS; 5 release blockers pending legal review |
| `pnpm sbom:generate`           | PASS                                          |

The full integration command required local
`directConnection=true` because Compose advertises the replica-set member as
`mongo:27017`. The first invocation without it failed during server selection;
the corrected invocation still used the real replica set and passed without
changing tests or timeouts.

## Worker And Queues

The final bundled worker was checked against real Mongo, Redis, PostgreSQL and
MinIO.

- All 13 canonical queues registered with concrete handlers.
- Redis meta keys matched all 13 queue names.
- Readiness was written only after all 13 consumers were ready.
- `SIGTERM` removed readiness and exited `0`.
- Missing secret configuration exited non-zero with readiness absent.
- Unknown and repeated registrations fail unit tests.
- Invalid payloads and cross-workspace Outbox events fail handler tests.

## C1 / C2 / C3

C1:

- Real S4 Outbox event dispatched through Redis/BullMQ.
- `knowledge-import` hydrated the parent Job from Mongo.
- Parent created one idempotent parse child and waited for all descendants.
- Parse then entered `waiting_children`, created the index child and waited for it.
- Real BullMQ import, parse and index workers completed the chain.
- Failed index descendants propagate through a terminal intermediate parse Job
  to the import root without being hidden by the prior parse success.

C2:

- Parse adapter called the existing S5 processing path.
- Raw text artifact was materialized in MinIO.
- Existing chunk and QA code ran through `S5ProcessingApplication`.
- Segment, full-text and vector projections were persisted with version CAS.

C3:

- Segment rows contain stable vector IDs, full-text version, index status,
  source version and four-profile storage metadata.
- 768, 1024, 1536 and 3072 writes were verified on real PostgreSQL; 3072 is
  stored as `halfvec`.
- No S7 retrieval or citation code was added.

## Rebuild, Sync And Cleanup

- Source rebuild CAS changes `ready/partial` to `rebuilding`.
- Concurrent rebuild returns `KNOWLEDGE_CONFLICT`.
- Old Segment pointers remain unchanged until every child switches.
- Space rebuild expands into source roots and index grandchildren.
- Nested parent aggregation finalizes bottom-up with version CAS.
- Sync reads provider pages, materializes content into MinIO, commits Source and
  cursor records in Mongo, and increments connector `cursorVersion` by CAS.
- Duplicate sync delivery replays the same cursor run without another Source,
  ObjectRef or parse child.
- A changed external document increments its Source `sourceVersion`.
- Sync creates one parse child per Source and only marks the connector active
  after the sync root reaches a terminal state.
- Duplicate sync delivery does not create another Source or child.
- Cleanup preserves active vectors and vectors newer than 30 days.
- Expired inactive vectors are deleted in a bounded batch.
- Caption creates a failed step with `KNOWLEDGE_DEPENDENCY_UNAVAILABLE` and never
  produces a vector or fake success.

## Job Controls

- Claim uses workspace, status, availability, kind and CAS guards.
- Lease owner, 300-second lease, 60-second heartbeat, attempt epoch and fencing
  token are persisted.
- Stale worker commit is rejected after restart or lease recovery.
- Pause, resume, cancel, retry and replay update the subtree with CAS.
- Replay preserves step evidence and records `replayHistory`.
- Root replay requeues failed descendants as well as the dead root.
- Parent terminals are finalized only after all descendants are terminal.
- A failed descendant always propagates to root `error`, `result.partial` and
  per-Source `errorCode`, including inconsistent legacy terminal-parent trees.

## UI Evidence

Jobs, Segments and Segment Edit passed at `360`, `768` and `1200` viewports with
axe serious/critical count `0`, horizontal overflow `0`, unexpected console
errors `0` and failed runtime requests `0`. The deliberate UI 409 test records
only the two expected browser resource messages and preserves the submitted
question/answer after both pointer and keyboard submission.

| Screenshot                 | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `s6-jobs-360.png`          | `9ea955032d29bc3595f4da49340ae02d5e965d103ffc374a2c2cc65b0af9a335` |
| `s6-jobs-768.png`          | `80a2fd481411425f466e9513c1488d08fc75f63e2221f9138d76e2cd834a5dad` |
| `s6-jobs-1200.png`         | `f27a1d453672cb92f0990bcb231cd81b52f58a481ee9c6ae083e434773a3783c` |
| `s6-segments-360.png`      | `2bbe3929d9282f22faba9a6e43f0ca8b5cb60a3b52d7c12c4fa4b403a380dfca` |
| `s6-segments-768.png`      | `3198cfe95f3f4c0980f2afd3333d7eeef241873804a5c289a6762b7feec9da57` |
| `s6-segments-1200.png`     | `98d1003bbbaedcb72ddc7a706364eabddae4232733d15365dd26c75324bc3a92` |
| `s6-segment-edit-360.png`  | `2086f105465e351e68b7d7700082329ee92c975d2c9d3c73b7e2595da58243ea` |
| `s6-segment-edit-768.png`  | `facd0add7177f08fe17e0e6673cfcacc8f7eb83228a973bef18ed27b6dddf9c9` |
| `s6-segment-edit-1200.png` | `0a7ffdb2052896bb3ecbb88da232521dbe1da5784621647ca5fc22ca610bb54d` |

## Review Remediation

- `S6-R01`: the connector-sync WIP was completed and committed rather than
  mixed into the prior evidence checkout. This evidence is generated from the
  new clean candidate and a separate docs-only commit.
- `S6-R02`: parse now waits for index descendants; failed descendants are
  propagated through terminal intermediates to root and Source evidence. Two
  regressions cover the live failure and the legacy inconsistent tree.
- `S6-R03`: the contract guard now names the exact S7 set with
  `API-CITATION-GET` and tests Image/Deep separately as S8.
- `S6-R04`: Segment Edit E2E now performs a real stale-version UI submission,
  checks 409, trace/request evidence, input preservation, keyboard submission,
  axe, overflow, console and network behavior.

## Evidence And Hygiene

- Lockfile SHA-256:
  `3c7c558ad9b930ec6c23aef17e4154b9e20fa134075fe7401b1cee5f201995f1`.
- `test-results/` is outside the repository.
- Unintended S3/S5 PNG rewrites from E2E were restored from `HEAD`.
- Generated OpenAPI files came from `pnpm openapi:generate`.
- No PR merge, dependency install or W2 personB gate was performed.

## Risks

- No production OCR, LLM, embedding or connector credentials were available.
- Connector orchestration is fixture-verified with deterministic Feishu pagination
  and content; external connector providers remain `EXTERNAL_UNVERIFIED`.
- S8 caption remains intentionally unsupported.
- Five production license blockers remain pending legal review.
- Optional PDF canvas warnings appear during bundled worker startup; readiness,
  shutdown and all required gates passed.
- W2 final `100 / 20` requires a pushed personA candidate SHA and the S6 merge SHA.

## Conclusion

`S6_BRANCH_PASS_PENDING_S7`
