# W2 personB Gate

## Decision

Status: `PASS`

Scope: `W2 personB read-only gate`

W2 wave closure: `PENDING_PERSONA_EVIDENCE`

- Wave: `W2`
- Stage under review: `S6 / personB` with parallel `S7 / personA`
- Candidate owner: `personA`
- Candidate branch: `feat/kb-s07-search-citation`
- Candidate SHA: `d237c028b514a923920cbc36bcb1bb71ee4d9747`
- W2 base SHA: `87ba3bdea3d7daf3e738a04998b80b49cbf7a77b`
- S6 merge SHA: `bc091a1513ec0a0b0b2b9412f0c8a397192ea3de`
- S6 PR: `https://github.com/serien1995chen-web/RAG-agent-platform/pull/30`
- S6 PR head SHA: `e6ca0d309f59cc69d018d8f79c8029fc809913a2`
- Worktree: `/home/archer/RAG-agent-platform-w2-personB-d237c028`
- Owner of this gate: `personB`
- Git state: detached checkout at the supplied candidate SHA

PersonB did not edit source, rebase, install dependencies, push, create a PR,
merge, or commit on the candidate branch. The supplied read-only dependency
view was extracted into the independent worktree. E2E-generated tracked
screenshots were preserved outside the worktree and the candidate files were
restored byte-for-byte from `HEAD`.

This PASS certifies the personB command gate and candidate facts recorded below.
It does not close W2. Wave closure still requires personA evidence, integration
of this markdown, a docs-only evidence commit, and CI on that evidence commit.

## Candidate Preflight

| Check                        | Result                                                  |
| ---------------------------- | ------------------------------------------------------- |
| `git rev-parse HEAD`         | PASS: `d237c028b514a923920cbc36bcb1bb71ee4d9747`        |
| Candidate commit             | `feat(s7): integrate search and citation with s6`       |
| Candidate commit time        | `2026-10-28 13:42:31 +0800`                             |
| Remote candidate branch head | PASS: `git ls-remote` equals candidate SHA              |
| W2 base is ancestor          | PASS: `git merge-base --is-ancestor` exited `0`         |
| S6 merge is ancestor         | PASS: `git merge-base --is-ancestor` exited `0`         |
| Working tree before gate     | PASS: empty tracked status                              |
| Working tree after all gates | PASS: empty tracked status                              |
| Final `git diff --check`     | PASS: exit `0`                                          |
| Final `test-results/`        | PASS: absent; E2E artifacts moved outside the candidate |
| Live worker at completion    | PASS: none; readiness marker removed                    |

Diff context:

- `base..HEAD`: 177 files changed, 24,741 insertions, 1,165 deletions.
- The only deleted path is `packages/service/src/types/pg.d.ts`; no test file,
  S4/S5/S7 UI asset, or `docs/acceptance/**-ui/**` asset was deleted.
- Baseline has 130 unique `TEST-*` IDs; candidate has 140 unique `TEST-*` IDs.

## Dependency View

- Archive: `C:\Users\Administrator\Downloads\w2-full-dependency-view-d237c028b514.tar.gz`
- Archive bytes: `330,234,672`
- Archive SHA-256:
  `06dfb143539921d14245fdd81fdc6f180d9239d7c21192accda39e414d2878a7`
- Candidate source `pnpm-lock.yaml` SHA-256:
  `31756b79284db42258c9140ca3c9c7ccb195d819633b05b6eaa3de7d0e59e72f`
- Installed `node_modules/.pnpm/lock.yaml` SHA-256:
  `31756b79284db42258c9140ca3c9c7ccb195d819633b05b6eaa3de7d0e59e72f`

Archive path checks passed: no absolute paths, no parent traversal, no `.git/`,
no `test-results/`, and no source-code top-level entries. The extracted view
contains the root virtual store, all workspace dependency layouts,
`projects/app/node_modules`, and the candidate lockfile.

Workspace links resolve inside the candidate worktree:

- `projects/app/node_modules/next` resolves inside the candidate's own
  `node_modules/.pnpm` directory.
- `packages/service/node_modules/@kb/qa` resolves to the candidate
  `packages/qa`.
- `packages/search/node_modules/safe-regex` resolves to the candidate virtual
  store.
- No workspace link targets `/home/serien` or the main S6 worktree.

All 6 exact S6 direct dependencies and all 21 exact S7 direct dependencies are
present at their designed versions. `pnpm list -r --depth 0 --json` contains the
root plus 12 workspace projects and produced no stderr.

No `pnpm install/add/update/remove` command was executed by personB.

## Environment

```text
date=2026-10-28T19:08:24+08:00
user=archer
kernel=Linux 6.6.87.2-microsoft-standard-WSL2 x86_64
node=v22.23.2
pnpm=10.33.4
git=2.34.1
docker=29.6.2
docker_compose=5.3.1
timezone=Asia/Shanghai
```

Real infrastructure checks:

- MongoDB `rs0` was PRIMARY and healthy.
- Redis returned `PONG`.
- PostgreSQL/pgvector accepted connections.
- MinIO health endpoint was healthy.
- Default and `aiproxy` Compose configuration validation passed.

`docker compose up -d --wait` returned non-zero only because the one-shot
`mongo-init` container exited `0`; all long-running services were healthy and
were independently checked.

## Contract, Runtime, And Capability

| Check                         | Result                                                         |
| ----------------------------- | -------------------------------------------------------------- |
| Target contract               | PASS: `92 paths / 120 operations / 139 schemas / 8 parameters` |
| Runtime / deferred            | PASS: `100 / 20`                                               |
| Runtime/deferred intersection | PASS: `0`                                                      |
| Runtime/deferred union        | PASS: `120`                                                    |
| S6 runtime operations         | PASS: `12 / 12`                                                |
| S7 runtime operations         | PASS: `5 / 5`                                                  |
| Canonical queues              | PASS: `13`, all unique                                         |
| Mongo collections             | PASS: `23`, all unique                                         |
| Vector profiles               | PASS: `768 / 1024 / 1536 / 3072`; 3072 uses `halfvec`          |
| Capability inventory          | PASS: `73 total / 12 BASE / 57 DATA / 4 EXCLUDED`              |
| W2 implemented                | PASS: `47`                                                     |
| W2 closed                     | PASS: `43`                                                     |
| Remaining DATA                | `10`                                                           |
| `DOWN-001...004`              | PASS: all remain `DATA`                                        |

Capability derivation:

- W1 evidence records 28 implemented and 27 closed.
- S6 contributes 10 implemented and 10 closed:
  `COL-002`, `DATA-002...004`, `TRAIN-001...005`, `TRAIN-007`.
- S7 contributes 9 implemented and 6 closed:
  `SEARCH-001/002/004/005/007/009`; `DOWN-001...003` are implemented but remain
  `DATA`.
- Result: `28 + 10 + 9 = 47` implemented and `27 + 10 + 6 = 43` closed.

S6 runtime operations, all present:

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

S7 runtime operations, all present:

```text
API-SEARCH-SEMANTIC
API-SEARCH-FULLTEXT
API-SEARCH-HYBRID
API-SEARCH-MULTI
API-CITATION-GET
```

No S7 operation remains in the deferred manifest.

## C1 / C2 / C3

C1 passed with real Mongo, Redis, and BullMQ:

- S4 Outbox events were dispatched through real BullMQ.
- `knowledge-import` hydrated the parent Job from Mongo.
- The parent created an idempotent parse child and waited for all descendants.
- Parse/index descendants completed and parent/child terminal aggregation passed.
- Failed descendants propagate to the root and Source evidence.
- Duplicate delivery did not create duplicate children.

C2 passed through the existing S5 implementation:

- The S6 processing application called `S5ProcessingApplication`.
- The existing parse, chunk, and QA path ran without a second parser,
  chunker, or QA implementation.
- Raw text was stored and read through the real MinIO object store.
- Segment, full-text, vector, and evidence rows were persisted.

C3 passed with real S6 output consumed by S7:

- `s7-s6-integration.test.ts` indexed a Segment through S6.
- The same Segment was returned through S7 full-text recall and pgvector recall.
- Final ACL hydration retained the same workspace, Source, and Segment.
- Multi-space hybrid retrieval returned both spaces with two distinct citations.
- The test used the S6 vector ID, index version, full-text version, Source ACL,
  and persisted pgvector row rather than a duplicate S7 fixture.

## Worker, Queue, And Job Controls

The built worker was started against Mongo, Redis, PostgreSQL, and MinIO with a
fresh Redis DB. The observed final state was:

```text
READY_MARKER_PRESENT
ready
queue_meta_count=13
stalled_check_count=13
```

The readiness marker is written only after `await workers.ready`, where
`workers.ready` is `Promise.all` over all 13 BullMQ workers. The observed queue
meta keys exactly match the 13 canonical queue names. `SIGINT` removed the
readiness marker and left no worker process.

Registry tests also prove that missing, unknown, duplicate, and non-function
handlers fail before startup. Handler tests reject malformed payloads and
cross-workspace Outbox hydration.

Job coverage passed:

- create, retry, cancel, pause, resume, replay;
- batch Segment operations;
- index create/update/delete;
- history and reindex;
- real UI Job controls through the runtime;
- lease recovery, heartbeat epoch, fencing token, and stale-worker rejection;
- worker restart and retry requeue;
- two concurrent claims allow exactly one winner.

## Embedding, Full-Text, Rebuild, Sync, And Cleanup

`s6-rebuild-sync-cleanup.integration.test.ts` passed against real
PostgreSQL/pgvector and MongoDB:

- 768, 1024, 1536, and 3072 vectors were written to their matching tables.
- 3072 was stored as `halfvec`; the other profiles used `vector`.
- The bundled worker includes `@node-rs/jieba`, full-text projection, and the
  four vector profiles.
- Full-text tokens and `fullTextVersion` were persisted and read through S7.
- Source and Space rebuilds retained old pointers until all child switches.
- Cleanup preserved active and recent vectors and deleted only expired inactive
  vectors.
- Connector sync materialized content through MinIO, advanced cursor state by
  CAS, and did not duplicate Source, ObjectRef, or parse children.
- Failed sync descendants retried the same Job tree and recovered the connector
  to `active`.
- Caption failed explicitly with `KNOWLEDGE_DEPENDENCY_UNAVAILABLE`; it did not
  fake S8 success or create a vector.

## UI

E2E passed Jobs, Segments, Segment Edit, Search, Import, Sources, Connectors,
catalog, and downstream pages. The S6 and S7 UI checks used the real app runtime
and canonical APIs.

S6-specific UI coverage:

- Jobs, Segments, and Segment Edit at `360`, `768`, and `1200`;
- axe serious/critical violations: `0`;
- horizontal overflow: `0`;
- unexpected console errors and failed runtime requests: `0`;
- real stale-version Segment Edit submission returned `409`;
- submitted Segment Edit input was preserved after the conflict.

All nine tracked S6 acceptance PNGs remain byte-identical to the hashes in
`docs/acceptance/s6-stage-evidence.md`. E2E-generated PNGs were moved outside the
candidate under `w2-personB-evidence-d237c028/test-results-e2e/`.

S7 UI evidence generated outside the candidate:

- Search page at `360`, `768`, and `1200`;
- Search component interaction artifact at mobile/tablet/desktop;
- all generated PNGs are valid non-zero-sized images with the expected
  viewport widths.

## Test And Build Matrix

| Gate                | Result                                                       |
| ------------------- | ------------------------------------------------------------ |
| Lint                | PASS                                                         |
| Format              | PASS                                                         |
| Typecheck, forced   | PASS, `12/12` packages, `0` cached                           |
| Architecture        | PASS, 112 service source files and 12 workspace packages     |
| Forbidden files     | PASS, 469 files                                              |
| Unit                | PASS, Turbo `22/22`, 286 tests                               |
| Contract            | PASS, 18 files, 90 tests                                     |
| Integration, forced | PASS, Turbo `22/22`; service 23 files, 129 tests             |
| Tenant              | PASS, 7 files, 15 tests                                      |
| Concurrency         | PASS, 6 files, 13 tests                                      |
| Fault               | PASS, 8 files, 32 tests                                      |
| E2E                 | PASS, 9 files, 41 tests                                      |
| Build               | PASS, `12/12` tasks                                          |
| Worker build        | PASS, `11/11` tasks; worker bundle and assets produced       |
| License             | PASS; 159 catalog entries, 949 production npm components     |
| SBOM                | PASS; `artifacts/sbom.json` and `NOTICE` regenerated cleanly |
| Compose             | PASS; default and AIProxy profiles                           |

## Command Evidence

`outputHash` is SHA-256 of the captured command log. Full logs and
`log-sha256.txt` are under
`/home/archer/w2-personB-evidence-d237c028/`.

| Command                                 | Exit | Result                                           | outputHash                                                         |
| --------------------------------------- | ---: | ------------------------------------------------ | ------------------------------------------------------------------ |
| `pnpm openapi:generate`                 |    0 | `92/120/139`, runtime `100/20`                   | `f4a65c7a551ab08ac049b2685b3db4f2b6825a168bc2b315eec4a50d293024f1` |
| `git status --porcelain` after generate |    0 | empty                                            | `cfe5cd7101cc8f0139996e75faea2f4f8d34355cc9c4affbe18774fbc8a9e861` |
| `pnpm openapi:check`                    |    0 | PASS                                             | `6c6fbac494aeb63bada1182afb8cc457941fd5d8049d4f0de17d49b5e2239c94` |
| `pnpm knowledge:inventory`              |    0 | `73/12/57`, contract `92/120/139/8`, `13` queues | `07ec0d7b4c26a756a2425afccbd9730367217d8c66eefa40bd3aef2ba41bd197` |
| `pnpm knowledge:check-runtime`          |    0 | `100/20`, intersection `0`, union `120`          | `a64bd007b210b149a757661f23ab477b4df3be6f30eeddf2c28b2a359e275ded` |
| `pnpm lint`                             |    0 | PASS                                             | `6c35be1debe25ebe1a68ba0cc8261d8ca5035a6e0d4f24935485076c846a43b7` |
| `pnpm format:check`                     |    0 | PASS                                             | `dea6a85ab779bed58b146e57117522462acf0039e04034bf1b4bf7e1d45bd2a6` |
| `pnpm typecheck --force`                |    0 | `12/12`, `0` cached                              | `b45773f45f4fa4a1e3fbf418e3c95a9694230cc7804fb91c62f5882ab15eb9ce` |
| `pnpm architecture:check`               |    0 | PASS                                             | `9d8caca0f5f0f42787ca33feb775b61b95f6446e725fb1b1f5b0dd2bebf23f7f` |
| `pnpm forbidden-files:check`            |    0 | PASS                                             | `b0a72b8f543d099b21c90df0358d2662b3649b138c082465b83b01ed35313552` |
| `pnpm test:unit --force`                |    0 | `22/22` tasks, 286 tests                         | `cc20f2191b39c9b901c145deaf3e965dd8f8cf66f872c36cc48f6b82d3841573` |
| `pnpm test:contract`                    |    0 | 18 files, 90 tests                               | `52548f3c852a95a32cef79f052c5e619c89c93f2d26011c2ad1e2215a9b8d00d` |
| `pnpm test:integration --force`         |    0 | `22/22` tasks, service 129 tests                 | `ede3fcdbce97457b226a761608caf9cb561083ed7109715216f538289fe2a80e` |
| `pnpm test:tenant`                      |    0 | 15 tests                                         | `29d728fb8f5b443fdfb46853496ef37a222394844690b7410b6f1f8f2adcc151` |
| `pnpm test:concurrency`                 |    0 | 13 tests                                         | `104cfa5f044df18d5f0fdafe7f1958f5b6236154cec31ba60b82f0ecbfe71b14` |
| `pnpm test:fault`                       |    0 | 32 tests                                         | `4667616a12a964e8f7d1026d12b27a89b17601110582480d7f4fb46e7f25735b` |
| `pnpm test:e2e`                         |    0 | 9 files, 41 tests                                | `a9e3eba60f7eb19812960488e42acee1f47d49571e1d5bff0788458885dcc93b` |
| `pnpm build --force`                    |    0 | `12/12`                                          | `9ff6d02e22ca063fbae0baecf2eb93d317532f3f6f9903a3e9f48b3a6266bde8` |
| `pnpm build:workers --force`            |    0 | `11/11`, bundle produced                         | `21745815b8462915d8fe7f07ce2d87dcc1b7f8b9585620e239185e0131a0aab5` |
| `pnpm license:check`                    |    0 | PASS with legal-review release blockers          | `068cc4852e3f2ea17242bbf9efdaf5fb2fd4b47fbb30f93ea32244f30dff20e7` |
| `pnpm sbom:generate`                    |    0 | SBOM and NOTICE clean                            | `3ee5429cffb449d72d23946167d1e7902da221e23f005e9c5ae3023171e1de43` |
| `pnpm list -r --depth 0 --json`         |    0 | root plus 12 workspace entries                   | `8a9eb2cb96223e68ac65b1ac5cb7e517e9eafadcd11dbe9aecf1c0d028e00cb4` |
| Static W2 assertions                    |    0 | contract/runtime/capability/UI assertions        | `f1032e53287ed4c27003aff36c72912bc77782eac4308f75c6af51546865cbf0` |
| Test-ID preservation                    |    0 | `130 -> 140`, no test/UI deletions               | `2b61c35f09417e1cccb8eab55d4f0e9e0198c3f346a50fab25e98ba32c260ae9` |
| Dependency-view checks                  |    0 | archive `330234672`, lock `31756b...`            | `910e66c9da91ca29cec962ae97659b96e3e178ca06dcff2f84892f5bebc10285` |
| Direct dependency assertions            |    0 | S6 `6` + S7 `21`, all exact                      | `cde1e57ad98ededdf6562618936a670192aef62d9d6a4dc0100a54fcda2f7617` |
| Fresh worker readiness                  |    0 | marker present, 13 queue meta keys               | `df553a7469a086fe999e7e6582b0eae4e11aa06d0c73b593cd0fe3ce1e1a1843` |
| Compose and infrastructure              |    0 | both configs, real services healthy              | `0b1701bb3599957a5337aad728b621739a1521d18d684f87e302b20016ae5a28` |
| Remote refs and ancestry                |    0 | candidate and main match; ancestry pass          | `93b9bd046f4332c9cdb8e142ef4df53a7a80bcde82a5b850bd1fe4802d2f6627` |
| PR #30 API                              |    0 | merged at `bc091a...`                            | `56e02a82b2d628362020f581be91e0489c0df63c7ef6eeac92548c4f479ff465` |
| Environment snapshot                    |    0 | versions and lock hashes                         | `bfbbc310768b74185ee63fcb5bc2a463f44706c660a629d81e40b721b88780ad` |
| Final status                            |    0 | empty, no `test-results`, no worker              | `e9abb28cdc1997f722ab22a91cb2e850d365c07ffb713b15dcd0a3e5c41189ce` |

## Generated Artifacts And Preservation

- OpenAPI generation was deterministic and left the tracked worktree clean.
- SBOM generation was deterministic and left `artifacts/sbom.json` and `NOTICE`
  byte-identical to `HEAD`.
- Worker build produced `projects/app/dist/workers/worker.mjs` and its assets.
- All nine S6 acceptance PNGs are still present and match the committed hashes.
- S6 operations, operations schemas, UI pages/components, tests, dependencies,
  and generated runtime/schema artifacts remain in the candidate.
- No S7 operation was removed or downgraded to deferred.
- No Deferred fake-success handler or route was found.

## External Verification

`REAL_VERIFIED`:

- Mongo replica-set transaction/lease behavior;
- Redis and BullMQ consumers, retry, restart, and fencing;
- PostgreSQL/pgvector four-profile writes and cosine recall;
- MinIO rawText and object lifecycle;
- S5 parse/chunk/QA through the local implementation;
- S6 index output consumed by S7 full-text/vector/ACL/citation flows;
- browser UI at three viewport widths with axe and network/console checks.

`FIXTURE_VERIFIED`:

- external OCR/LLM/embedding responses used by deterministic test ports where
  production credentials were unavailable;
- Rerank behavior used the allowed mock/fault path.

`EXTERNAL_UNVERIFIED`:

- production OCR, LLM, embedding, and connector credentials;
- final API-key scope behavior used to close `DOWN-001...004` in S10;
- production PDF renderer without the optional `@napi-rs/canvas` package.

## Risks

- The candidate-specific PR and check-run URL were not supplied. PR #30 is the
  merged S6 PR; this report is the independent personB local gate. PersonA must
  add this evidence, create the docs-only evidence commit, then run/finalize CI.
- Five license items remain release blockers pending legal review:
  `argparse`, `caniuse-lite`, `jschardet`, `pako`, and `sax`.
- Optional PDF canvas warnings appeared during worker startup because
  `@napi-rs/canvas` is not installed. All required W2 tests and worker readiness
  passed, but production PDF rendering remains a risk.
- Production OCR, LLM, embedding, connector, and API-key behavior remain
  external-unverified.
- `DOWN-001...004` remain `DATA`; S10 owns final closure.

## Conclusion

`W2_PERSONB_GATE_PASS`

W2 is not closed by this document alone. PersonA must preserve this content,
provide the personA evidence for the same candidate SHA, create the allowed
docs-only evidence commit, and record successful CI for that commit before the
W2 wave evidence can declare `W2_PASS`.
