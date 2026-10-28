# S9 Synonym and Rebuild Stage Evidence

## Status

- Wave / stage / owner: `W3 / S9 / personA`.
- Parallel stage: `S8 / personB`, merged first.
- Branch: `feat/kb-s09-synonym-rebuild`.
- Worktree: `/home/serien/RAG-agent-platform-s09`.
- W3 baseline: `13fa0e9be84edd33ea5cc5413d64282c126dd117`.
- S8 merge SHA: `9839b2a1005ce7fdf4558ea8d002ae1ab6dcadbd`.
- S8 merge parents: `13fa0e9be84edd33ea5cc5413d64282c126dd117` and
  `1c55abb2fa1ecc5bdafaa2d3d3a26f05df24f4c`.
- Candidate SHA: the commit containing this report; the exact SHA is recorded
  in the handoff because a commit cannot include its own object ID.
- Evidence commit SHA: not created. It requires personA and personB evidence
  from the same frozen candidate.
- W3 conclusion: `NOT_COMPLETE`. PersonB independently executed evidence has
  not been received.

This report records post-rebase S9 implementation and local gate results. It
does not claim that W3 is complete and does not claim a final CI or Review
result.

## Inputs

| Input                                    | SHA-256                                                            |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `S9-实现方案与审查标准.md`               | `fb52bf9991964ca23e79e1aa1ec4b8ba85c80f4488691c83f97b645286a56cb0` |
| `KnowledgeBase-System-Design.md`         | `8e5e7300c651c4fe0478b87fc3572add52f95c3e49c8f15700b45bb8c690a26d` |
| `知识库平台分阶段任务拆解-继续开发版.md` | `11aa3693599759ef969c9f6ad85ae61da8fd925940baacfb17a1c5c389e2fb6e` |
| `coding.md`                              | `6160d409fa57ea0de6bef24777979492f0ed10520070032ac5df578211ef8cc9` |

The Plan has seven Tasks with the required twelve fields, atomic steps with the
required nine fields, eight Operations, C5/C6 and the shared-file ownership
rules. No unresolved documentation or baseline conflict was found.

## Scope

Implemented Tasks:

```text
S9-T01 S9-T02 S9-T03 S9-T04 S9-T05 S9-T06 S9-T07
```

Capabilities implemented by this stage:

```text
SEARCH-003
TRAIN-006
```

The canonical manifest still stores its historical `DATA` lifecycle value.
This stage records the W3 post-rebase implementation count as
`53 implemented / 49 closed`. `DOWN-001...004` remain `DATA`; no W4 work was
implemented.

Registered Operations:

```text
API-SYNONYM-GET
API-SYNONYM-UPLOAD
API-SYNONYM-UPDATE
API-SYNONYM-DELETE
API-SYNONYM-DOWNLOAD
API-SYNONYM-MAPPINGS
API-SYNONYM-ENABLE
API-SYNONYM-REBUILD
```

All eight Operations are runtime. S8 `API-SEARCH-IMAGE` and
`API-SEARCH-DEEP` remain runtime.

## Implemented Behavior

### T01 / T02: Immutable Files and Validation

- CSV, XLS and XLSX use a stage-specific parser.
- CSV is fatal UTF-8; BOM and CRLF are accepted.
- XLS/XLSX read only the first worksheet and validate container signatures.
- File limits are 10 MiB, 10,000 mappings, 50,000 terms, 128 code points per
  term and 500,000 total code points.
- Header aliases and deterministic row-level diagnostics follow the Plan.
- Duplicate, self-reference, cascade, cycle and cross-standard conflicts return
  structured `KNOWLEDGE_SYNONYM_INVALID` diagnostics without file text.
- Mapping fingerprints, logical IDs and ordering are deterministic.

### T03: Version, CAS, Delete and Download

- `activeFileVersion` is never nullable.
- Only `publishedFileVersion` participates in query expansion and new index
  versions.
- Checksum history is reused across retained versions.
- Upload/update writes config, immutable mappings, ObjectRef, Job, Outbox and
  Audit in one Mongo transaction.
- Idempotency-Key and SHA-256 are persisted; changed bodies conflict.
- Enable/disable/delete use config-version CAS.
- Delete is fixed to `enabled=false` and `status=disabled`.
- Delete clears pending and published state but retains `activeFileVersion` and
  historical mappings.
- Mapping pagination is stable and bounded to `1...200`.
- Download returns canonical UTF-8 BOM CSV using CRLF and RFC 4180 quoting.
- Synonym ObjectRef keys use the tenant-scoped
  `ws/{workspaceId}/space/{spaceId}/synonym/...` template.

### T04: Query Extension

- The pure matcher lives in `packages/search/src/synonym-expansion.ts`.
- Original query text is retained and standards are appended deterministically.
- ASCII case normalization, internal whitespace, Unicode and punctuation follow
  the Plan.
- Longest matching and Latin/digit/underscore boundaries are enforced.
- Multiple Spaces combine in request order without one Space overwriting
  another.
- The 4096-code-point limit falls back to the original query.
- Cache keys include workspace, Space and fileVersion.
- Every cache hit revalidates the published version directly in Mongo.
- Disabled, changed-version, cache-mismatch and repository failures fall back to
  the original query.
- Embedding and full-text recall receive the same expanded text.
- Audit summaries contain only Space IDs, versions and mapping IDs.

### T05: Synonym, Model and Source Rebuild

- `synonym_rebuild` uses the existing `knowledge-rebuild` queue.
- Upload/update and manual rebuild create the existing Job DTO.
- Embedding binding changes create a model-change rebuild in the same Mongo
  transaction as the binding update.
- Search resolves the internal `activeQueryModelId` and
  `activeQueryDimension`, not the public target binding.
- Rebuild staging and vector writes use the S6 Ports.
- Full-text and Segment pointer switch use the S6 store Port.
- Source/index rebuild writes the current published `synonymVersion`.
- Final Job, Segment pointers, config and internal model profile switch in one
  Mongo transaction.
- Finalization checks Job version, lease owner, fencing token and attempt epoch.
- Failure preserves the prior published version and compensates staged vectors.
- Old vector cleanup candidates are no earlier than 30 days after switch.

### T06: Synonyms UI

- Independent state, request client and workbench are wired to the real page.
- The page supports GET, upload, update, enable/disable, delete, download,
  mapping pagination and rebuild.
- Rebuild progress reads the existing Job list and polls while rebuilding.
- `fetch` is bound to `globalThis`, preventing browser `Illegal invocation`.
- Read/manage controls are permission-gated.
- Errors expose code, message key, trace ID and row diagnostics.
- Navigation, app page, i18n, query keys, web barrel and runtime registration
  are complete after S8 merge.
- Images, Deep/Search and Synonyms entries remain present together.

## C5 / C6

C5:

- S9 calls S6 rebuild/index Ports and S7 query expansion; it does not write
  pgvector, full-text or S7 candidates directly.
- The published version remains the query target until successful finalization.
- Rebuild failure retains the old target and records failure evidence.

C6:

- Every repository predicate includes `workspaceId`; cross-tenant access returns
  `404`.
- Space read/manage permissions and final ACL checks remain authoritative.
- Audit and Job evidence contain versions, counts, IDs and safe error codes,
  never synonym file contents or complete term lists.
- Job, Outbox and Audit facts remain consumable by S10.

## Shared Files

The post-rebase union touches the Plan-authorized shared surfaces:

- OpenAPI builder and generated runtime/deferred/route/client artifacts.
- S5 model binding repository, S6 processing Ports/repository/worker dispatch.
- S7 search application, Ports, pipeline factory and repository.
- knowledge application/runtime/barrels and the API handler.
- web shell, i18n, query keys, web/app barrels and route page.
- Queue/Job dispatch and pgvector/full-text shared Ports.

No S8 vision embedding, caption, Deep, Images, dependency, test, registry or
generated artifact was removed or rewritten.

## Contract And Runtime

| Check                           | Result    |
| ------------------------------- | --------- |
| Paths                           | `92`      |
| Operations                      | `120`     |
| Schemas                         | `139`     |
| Parameters                      | `8`       |
| Runtime                         | `110`     |
| Deferred                        | `10`      |
| Runtime / deferred intersection | `0`       |
| Runtime / deferred union        | `120`     |
| S8 runtime Operations           | `2 / 2`   |
| S9 runtime Operations           | `8 / 8`   |
| Mongo collections               | `23`      |
| Vector profiles                 | `4`       |
| Canonical queues                | `13`      |
| W3 Capability target            | `53 / 49` |
| DOWN-001...004                  | `DATA`    |

`pnpm openapi:generate`, `pnpm openapi:check`, `pnpm knowledge:inventory` and
`pnpm knowledge:check-runtime` pass.

## Installation

- Coding Agent executions of `pnpm install/add/update/remove`: `0`.
- User installation 1: S8 dependency pause, recorded in S8 evidence.
- User installation 2: post-S9-rebase, `pnpm install`, exit `0`, lockfile up to
  date, one package added.
- Final `pnpm-lock.yaml` SHA-256:
  `a12d7b5430abfb013b6af52dbabc6d6a30c0b96b4f6f48d1a4d0454b3a691e7f`.

## Test Evidence

All commands ran from the WSL worktree with real local Mongo replica set,
Redis, PostgreSQL/pgvector and MinIO. Provider mode was the repository's mock
AIProxy fixture; external cloud Providers remain `EXTERNAL_UNVERIFIED`.

| Gate                    | Result                                              |
| ----------------------- | --------------------------------------------------- |
| `pnpm test:unit`        | PASS, Turbo `22 / 22`                               |
| `pnpm test:contract`    | PASS, 20 files / 95 tests                           |
| `pnpm test:integration` | PASS, Turbo `22 / 22`; service 29 files / 163 tests |
| `pnpm test:tenant`      | PASS, 8 files / 17 tests                            |
| `pnpm test:concurrency` | PASS, 8 files / 16 tests                            |
| `pnpm test:fault`       | PASS, 10 files / 34 tests                           |
| `pnpm test:e2e`         | PASS, 14 files / 58 tests                           |
| `pnpm test`             | PASS, exit `0`                                      |

The full `pnpm test` log is `/tmp/s9-pnpm-test.log` with SHA-256
`583a077696946a6644b56b59e31ee8a8f8eb710fd18d0ef33dd5439a52c011d5`.

S9-specific coverage includes:

- CSV/XLS/XLSX, first worksheet, UTF-8/BOM, forged container signatures and 10
  MiB boundaries.
- `10 MiB`, `10 MiB + 1 byte` and `11 MiB + 1 byte` real HTTP multipart cases.
- Header/schema diagnostics, all conflict classes, codepoint and length limits.
- Immutable versions, checksum replay, idempotency conflict, CAS, delete history,
  mapping pagination and BOM CSV.
- Active query profile before and after model-change rebuild.
- Source/index published synonymVersion propagation.
- Query expansion, 4096 fallback, cache revalidation, Space ordering and ACL
  safety.
- Rebuild stage/finalize ordering, retry evidence, rollback and 30-day cleanup.
- Real Synonyms page at 360/768/1200, axe serious/critical `0`, keyboard,
  no horizontal overflow and rebuild progress.

Test IDs exercised include:

```text
TEST-SEARCH-003-BLOCK
TEST-TRAIN-001-BLOCK
TEST-TRAIN-003-BLOCK
TEST-TRAIN-006-BLOCK
TEST-MODEL-002-BLOCK
TEST-AUTH-001-BLOCK
TEST-AUTH-003-BLOCK
TEST-X-SYNONYM-REBUILD
TEST-X-PGVECTOR-PARTIAL
TEST-X-FRONTEND-A11Y
ACC-UI-01...07
```

### Screenshots

The real page screenshots remain under ignored
`test-results/s09-synonyms-real-ui/`.

| Screenshot    | SHA-256                                                            |
| ------------- | ------------------------------------------------------------------ |
| `mobile.png`  | `bd07dafe409a069e99e5bed592998ec4c2490ef10cf0035458f362fefcd933e0` |
| `tablet.png`  | `84c0c80a8d51487e11e425d9bd16d2c3431181250519bdd3206fcf40636cb7a8` |
| `desktop.png` | `45ecc872c402f4d5c3a7478994be1e5effe4d65f6ff63a9c4aee58dd970ef73d` |

## Static And Build Gates

| Command                      | Result                                                  |
| ---------------------------- | ------------------------------------------------------- |
| `pnpm lint`                  | PASS                                                    |
| `pnpm format:check`          | PASS                                                    |
| `pnpm typecheck`             | PASS, 12 packages                                       |
| `pnpm architecture:check`    | PASS, 133 service sources and 12 packages               |
| `pnpm forbidden-files:check` | PASS, 544 files                                         |
| `pnpm license:check`         | PASS; five release blockers remain pending legal review |
| `pnpm sbom:generate`         | PASS                                                    |
| `pnpm build`                 | PASS, 12 packages                                       |
| `pnpm build:workers`         | PASS; worker bundle and assets generated                |
| `docker compose ... config`  | PASS, 342 lines / 13 queues                             |

Compose config SHA-256:
`bf10017c84ec56a1c8b3307c182102414855af41ed874bab1bebc9dff9eb8435`.

## Risks And Open Items

- PersonB evidence is not present. W3 cannot be marked complete.
- Candidate and evidenceCommit SHA values must be frozen after this report is
  committed.
- CI, Review and PR Review have not run.
- The five license items remain release blockers, not CI blockers.
- External cloud Providers and FastGPT Cloud behavior remain
  `EXTERNAL_UNVERIFIED`.
- One parallel integration run exposed a transient archive retry timing failure;
  the failed file passed standalone and the subsequent complete integration run
  passed 163/163. It remains a residual flake risk.

Next authorized steps:

1. Commit the current S9/S8 union and lockfile to freeze `candidateSha`.
2. Run personA gates in a clean worktree at that SHA and write
   `docs/acceptance/w3-personA-gate.md`.
3. Notify the user to push the A branch and provide the same SHA to personB.
4. Accept personB's evidence unchanged, then create the acceptance-only evidence
   commit and wave report.
