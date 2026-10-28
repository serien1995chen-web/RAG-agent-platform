# S6 Stage Evidence

## Status

- Wave: `W2`.
- Stage: `S6 / personB`.
- Branch: `feat/kb-s06-job-index`.
- Candidate SHA: `c398593db550e6d4832a24642b368f11bac22ff8`.
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
`c398593db550e6d4832a24642b368f11bac22ff8` with the real local infrastructure
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
| `pnpm test:integration`        | PASS, Turbo 21/21; service 114 tests          |
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
- A failed sync connector returns to `syncing` in the same transaction as
  retry/replay of the sync root or any failed parse/index descendant; terminal
  success clears the prior error and returns it to `active` without duplicating
  provider artifacts.
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
| `s6-jobs-360.png`          | `8847b9fe71beaece60fbfbd3089e9dd8e6a7a11a0ff63ca6d78cb9d544cedcea` |
| `s6-jobs-768.png`          | `9fec9610ad531d4a2502541507e9f88f68aa0a0770bb0163089656dae5d2ca22` |
| `s6-jobs-1200.png`         | `7b9d3c8ce47ba4f53b9f17acb573ad4b4a5d9734910fd64de96025062b5cdc8e` |
| `s6-segments-360.png`      | `7199a6fa4688d23da5bf6a0c3b1238c313baa773059c1df5e08536e6f2c91f74` |
| `s6-segments-768.png`      | `b41977f4f3582826c21566586cf390938001e7cfe60439737626acedec30aede` |
| `s6-segments-1200.png`     | `67b8d3315a595fd99fc67a167d8d0820ed29dd44feb4b283380c1ea77dd1e067` |
| `s6-segment-edit-360.png`  | `879b3e755245f55623e97681eac882b3ae01496b4a2602492d2718526782c538` |
| `s6-segment-edit-768.png`  | `eda33844ffd23d7c04f42a52d83171a468ef341f5118433b1eb3189132fb0bb6` |
| `s6-segment-edit-1200.png` | `c5c59acf8b950ef33b3d6b53a749460a4d77a49d3abdeed59f68dc71db7c61ea` |

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
- `S6-R05`: failed sync connector state is restored to `syncing` in the Job
  retry/replay transaction, the same Job then recovers to `active`, and the
  regression proves cursor stability with no duplicate Source, ObjectRef or
  parse child.
- `S6-R06`: Jobs UI retry on a failed parse/index child now locates the sync
  root in the same Job tree, restores its connector to `syncing`, and requeues
  the root and failed descendants in one Mongo transaction.

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
