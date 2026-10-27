# S6 Stage Evidence

## Status

- Wave: `W2`.
- Stage: `S6 / personB`.
- Branch: `feat/kb-s06-job-index`.
- Candidate SHA: `868c819b25d7493a1e6ccf6d87837f9728b499cd`.
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
`868c819b25d7493a1e6ccf6d87837f9728b499cd` with the real local infrastructure
environment and exited `0`.

| Gate                           | Result                                        |
| ------------------------------ | --------------------------------------------- |
| `pnpm lint`                    | PASS                                          |
| `pnpm format:check`            | PASS                                          |
| `pnpm typecheck`               | PASS, 12 packages                             |
| `pnpm architecture:check`      | PASS, 97 service sources                      |
| `pnpm forbidden-files:check`   | PASS, 410 files                               |
| `pnpm test:unit`               | PASS, Turbo 21/21                             |
| `pnpm test:contract`           | PASS, 79 tests                                |
| `pnpm test:integration`        | PASS, Turbo 21/21; service 109 tests          |
| `pnpm test:tenant`             | PASS, 12 tests                                |
| `pnpm test:concurrency`        | PASS, 13 tests                                |
| `pnpm test:fault`              | PASS, 25 tests                                |
| `pnpm test:e2e`                | PASS, 36 tests                                |
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
- Parse then created the index child.
- Real BullMQ import, parse and index workers completed the chain.

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
- Sync deduplicates source IDs, creates one parse child per Source and preserves
  the cursor version for the S4 change-set boundary.
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

## UI Evidence

Jobs, Segments and Segment Edit passed at `360`, `768` and `1200` viewports with
axe serious/critical count `0`, horizontal overflow `0`, console errors `0` and
failed runtime requests `0`.

| Screenshot                 | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `s6-jobs-360.png`          | `49eec1e2c796529509c55e5c8ed8c75e397ca57518ee66d11a1b41fc3acce932` |
| `s6-jobs-768.png`          | `b2669b2aee2d78d645e866dce31aa24ea7254e27269744e175f7be84a083361a` |
| `s6-jobs-1200.png`         | `5d9e6515eb248b52ecf4e553637d03f1b32e4cc8eadb0b2f48390cec5a2f2898` |
| `s6-segments-360.png`      | `f5b337202e4bc3bf65d0b11fcfc6d65b93e22339d0d50ca8d00f35e060122433` |
| `s6-segments-768.png`      | `6a8b87cb479fce4dbb5fdf57d5ff261ef2aa61bb7c0069839931a0c16f88ff56` |
| `s6-segments-1200.png`     | `b6098907146dd5feb9e8a0731e1a2eabb0c8d9ba9fc36fe6c847829c21a1547e` |
| `s6-segment-edit-360.png`  | `ca760984c6bda3050d5a16325e837100997b01aa6db40360ea2dfc80d3f46f56` |
| `s6-segment-edit-768.png`  | `6546298957d035fd7d6aa8601a5d32382465f1ff765497b538af31e5d8532317` |
| `s6-segment-edit-1200.png` | `2fdb71b8d33287d7b1e03c7fdd3e12ef4e6ce91d30c789f39e5778b09154ea4e` |

## Evidence And Hygiene

- Lockfile SHA-256:
  `3c7c558ad9b930ec6c23aef17e4154b9e20fa134075fe7401b1cee5f201995f1`.
- `test-results/` is outside the repository.
- Unintended S3/S5 PNG rewrites from E2E were restored from `HEAD`.
- Generated OpenAPI files came from `pnpm openapi:generate`.
- No push, PR, merge, dependency install or W2 personB gate was performed.

## Risks

- No production OCR, LLM, embedding or connector credentials were available.
- Connector remote change discovery remains external-unverified; the verified S6
  path uses an existing-Source batch supplied by S4.
- S8 caption remains intentionally unsupported.
- Five production license blockers remain pending legal review.
- Optional PDF canvas warnings appear during bundled worker startup; readiness,
  shutdown and all required gates passed.
- W2 final `100 / 20` requires a pushed personA candidate SHA and the S6 merge SHA.

## Conclusion

`S6_BRANCH_PASS_PENDING_S7`
