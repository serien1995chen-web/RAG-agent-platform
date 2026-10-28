# S9 Synonym and Rebuild Stage Evidence

## Status

- Wave / stage / owner: `W3 / S9 / personA`.
- Parallel stage: `S8 / personB`, merged first.
- Branch: `feat/kb-s09-synonym-rebuild`.
- Worktree: `/home/serien/RAG-agent-platform-s09`.
- W3 baseline: `13fa0e9be84edd33ea5cc5413d64282c126dd117`.
- S8 merge SHA: `PENDING_USER_CONFIRMATION`.
- Candidate SHA: `PENDING_POST_REBASE`.
- Evidence commit SHA: `PENDING_POST_REBASE`.
- Phase 1 conclusion: `PHASE1_PASS_WAITING_FOR_S8_MERGE_SHA`.
- W3 conclusion: `NOT_RUN`.

No rebase, dependency installation, push, PR creation, merge or wave-level
candidate freeze was performed. This document does not claim S9 or W3 complete.

## Inputs

| Input                                    | SHA-256                                                            |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `S9-实现方案与审查标准.md`               | `fb52bf9991964ca23e79e1aa1ec4b8ba85c80f4488691c83f97b645286a56cb0` |
| `KnowledgeBase-System-Design.md`         | `8e5e7300c651c4fe0478b87fc3572add52f95c3e49c8f15700b45bb8c690a26d` |
| `知识库平台分阶段任务拆解-继续开发版.md` | `11aa3693599759ef969c9f6ad85ae61da8fd925940baacfb17a1c5c389e2fb6e` |
| `coding.md`                              | `6160d409fa57ea0de6bef24777979492f0ed10520070032ac5df578211ef8cc9` |

The implementation standard contains seven Tasks, each with the required
twelve fields, atomic steps with the required nine fields, eight Operations,
C5/C6, and the shared-file ownership matrix. No unresolved baseline conflict was
found.

## Scope

Tasks implemented through the phase 1 boundary:

```text
S9-T01 S9-T02 S9-T03 S9-T04 S9-T05 S9-T06 S9-T07
```

Capabilities touched but not closed:

```text
SEARCH-003
TRAIN-006
```

The branch remains at the W3 start capability ledger. `SEARCH-003` and
`TRAIN-006` remain `DATA`; the W3 target `53 / 49` was not claimed.

The eight existing Operations remain in the OpenAPI target and deferred manifest:

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

Phase 1 did not add these operations to the public runtime, create a public page
route, expose navigation, or modify generated OpenAPI/client registry files.

## Implemented Behavior

### T01 / T02: Immutable Files and Validation

- S9-specific CSV/XLS/XLSX parser.
- CSV is fatal UTF-8; BOM and CRLF are accepted.
- Only the first XLS/XLSX worksheet is read.
- XLS/OLE and XLSX/ZIP container signatures are checked.
- Files above `10 MiB` fail with `KNOWLEDGE_PAYLOAD_TOO_LARGE`.
- Header aliases cover standard and synonym forms from the Plan.
- Limits cover `10,000` mappings, `50,000` terms, `128` code points per term and
  `500,000` total code points.
- Diagnostics carry source row/column, stable code and message key without file
  text.
- Duplicate terms, self-reference, cascade, cycle and cross-standard conflicts
  are classified.
- Mapping order, logical IDs and fingerprints are deterministic.

### T03: Version, CAS, Delete and Download

- `activeFileVersion` is never nullable.
- `publishedFileVersion` is the only query/expansion/new-index source.
- New checksums receive monotonic immutable versions.
- Full retained history is reused by checksum.
- Upload/update creates pending config, mappings, ObjectRef, Job, Outbox and
  Audit in one Mongo transaction.
- Idempotency-Key and SHA-256 are recorded; mismatched idempotent bodies return
  `409`.
- Enable/disable/delete use config version CAS.
- Delete is fixed to `enabled=false`, `status=disabled`, clears pending and
  published state, and preserves the last `activeFileVersion` plus historical
  mappings.
- Mapping pages use stable cursor ordering and bounded `1...200` limits.
- Download returns canonical UTF-8 BOM CSV with CRLF and RFC 4180 quoting.

### T04: Query Extension

- Pure synonym matcher lives in `packages/search/src/synonym-expansion.ts`.
- Original query remains the prefix; standard terms are appended at stable
  matched order.
- ASCII is case-normalized only; internal whitespace, Unicode and punctuation
  remain significant.
- Longest synonym and Latin/digit/underscore boundaries are enforced.
- Standard terms are protected as no-op spans.
- Multiple authorized Spaces retain request order and append all distinct
  standards without overwriting.
- Same-Space mappings sort by normalized standard and logical mapping ID.
- Expansion above `4096` code points falls back to the original query.
- Cache keys include workspace, Space and fileVersion.
- Every cache hit still performs a direct Mongo published-version check.
- Disabled, version-change, cache-mismatch and repository failures fall back to
  the original query.
- Audit summaries contain Space IDs, fileVersions and mapping IDs only.

Phase 1 intentionally does not export or attach this module to the public
`@kb/search` barrel or S7 engine.

### T05: Synonym Rebuild

- Internal `synonym_rebuild` Job kind is used with the existing
  `knowledge-rebuild` queue.
- Queue handler contract is implemented in the stage-specific rebuild
  application.
- Rebuild stages through an S6 rebuild/index Port; S9 never writes pgvector or
  full-text projections directly.
- S6 adapter exposes `stageProfile`, `reuseOrBuildVector`, `finalize` and
  `rollback`.
- Rebuild result records source IDs, Segment versions, old/new file versions,
  old/new query model profile, failure evidence and cleanup candidates.
- Final config/model switch requires the current Job version, lease owner,
  fencing token and attempt epoch; a stale worker cannot publish.
- Failure before finalization preserves the prior published fileVersion.
- Partial finalization invokes staged-index compensation.
- Old vector cleanup candidates are no earlier than 30 days after switch.

The shared S6 worker dispatch, real staging implementation and atomic shared
Mongo finalization remain post-rebase work because they modify S8-owned runtime
and worker files.

### T06: Independent UI

- Independent state machine, request client and `S09SynonymsWorkbench` exist.
- Controls cover upload, update, mapping pagination, enable/disable, delete,
  historical download and rebuild.
- Read/manage capability gating is represented.
- Errors expose messageKey/code/traceId and row diagnostics, not file text.
- No public route, navigation, i18n key, web/app barrel or shared runtime entry
  was added in phase 1.

## C5 / C6

C5:

- S9 uses S6 rebuild/index Ports and an injected search expansion function.
- No direct pgvector, full-text, S7 candidate or Segment pointer write exists in
  the phase 1 S9 application.
- Published version remains the only query target before successful switch.
- Rebuild failure retains old published state and records failure evidence.

C6:

- Every synonym repository query includes `workspaceId`.
- Cross-tenant config and mapping access returns `404`.
- Read/manage permission checks are applied before application methods.
- Audit records contain checksums, versions, counts, Job IDs and error codes,
  never complete synonym files or term lists.
- Job, Outbox and Audit facts can be consumed by S10.

## Shared Files

Phase 1 minimal shared-file changes:

- `packages/service/src/shared/persistence/schemas/knowledge-governance.schemas.ts`
- `packages/service/src/shared/persistence/schemas/knowledge-operations.schemas.ts`
- `packages/service/src/modules/knowledge/application/ports.ts`
- `packages/service/src/modules/knowledge/application/s06-processing-ports.ts`
- `packages/service/src/modules/knowledge/repository/s06-processing.repository.ts`
- `packages/service/src/modules/knowledge/repository/job-execution.repository.ts`
- `packages/service/src/modules/knowledge/repository/s5-model-binding.repository.ts`

No public DTO, Schema name, route, collection or queue was added. Internal query
model fields keep the last successful embedding profile while the public binding
moves to the requested target model.

## Contract And Runtime

| Check                           | Result  |
| ------------------------------- | ------- |
| Paths                           | `92`    |
| Operations                      | `120`   |
| Schemas                         | `139`   |
| Parameters                      | `8`     |
| Runtime                         | `100`   |
| Deferred                        | `20`    |
| Runtime / deferred intersection | `0`     |
| Runtime / deferred union        | `120`   |
| S9 operations runtime           | `0 / 8` |
| S9 operations deferred          | `8 / 8` |
| Mongo collections               | `23`    |
| Vector profiles                 | `4`     |
| Canonical queues                | `13`    |
| Old page route                  | `0`     |

`pnpm openapi:check`, `pnpm knowledge:inventory` and
`pnpm knowledge:check-runtime` pass. W3 target `110 / 10` is explicitly not
claimed in phase 1.

## Test Evidence

Commands were run from the WSL worktree. Infrastructure tests used the real
local Mongo replica set, Redis, PostgreSQL/pgvector and MinIO. The local
replica-set member advertises `mongo:27017`, so commands used
`directConnection=true` without changing tests or timeouts.

| Gate                    | Result                                     |
| ----------------------- | ------------------------------------------ |
| `pnpm test:unit`        | PASS, Turbo `22 / 22`; 323 tests           |
| `pnpm test:contract`    | PASS, `93 / 93`                            |
| `pnpm test:integration` | PASS, Turbo `22 / 22`; service `142 / 142` |
| `pnpm test:tenant`      | PASS, `16 / 16`                            |
| `pnpm test:concurrency` | PASS, `15 / 15`                            |
| `pnpm test:fault`       | PASS, `33 / 33`                            |
| `pnpm test:e2e`         | PASS, `51 / 51` in ten files               |

S9-specific coverage:

- Parser: CSV/XLS/XLSX, first worksheet, UTF-8/BOM, forged signatures, extension
  and 10 MiB boundary.
- Domain: header/schema diagnostics, duplicate/self/cascade/cycle/cross-standard
  conflicts, 128 code points, mapping/term/total-length limits.
- Repository: immutable versions, checksum replay, idempotency conflict, published
  snapshot, CAS pagination and delete history.
- Query extension: original-query preservation, longest match, boundaries,
  standard no-op, multi-Space order, cache revalidation, mismatch/disabled
  fallback and 4096 limit.
- Rebuild: stage/finalize ordering, retry evidence, rollback, queue contract,
  Port-only S6 usage and 30-day cleanup candidate.
- UI: 360/768/1200 overflow, axe serious/critical `0`, keyboard focus and
  409/413/422/429 error states.

Test IDs exercised include:

```text
TEST-SEARCH-003-BLOCK
TEST-TRAIN-001-BLOCK
TEST-TRAIN-006-BLOCK
TEST-AUTH-001-BLOCK
TEST-X-PGVECTOR-PARTIAL
TEST-X-FRONTEND-A11Y
ACC-UI-01...07
```

### Screenshots

| Screenshot    | SHA-256                                                            |
| ------------- | ------------------------------------------------------------------ |
| `mobile.png`  | `f6ed2c3f70483305bfb52043f9f208445088a9abce63c7bf8fb5c60aec526a90` |
| `tablet.png`  | `d98d1f8ec1edd8efcd4463035ea7d3fa55d40673f619dce5c6ab2c3934ad0afc` |
| `desktop.png` | `3d88c6c360d6720d4a6c030d77693d653cb607f32fae1632089dfb410906f913` |

Screenshots and full browser logs remain under ignored `test-results/`; they are
not committed.

## Static And Build Gates

| Command                                                      | Result                                           |
| ------------------------------------------------------------ | ------------------------------------------------ |
| `pnpm lint`                                                  | PASS                                             |
| `pnpm format:check`                                          | PASS                                             |
| `pnpm typecheck`                                             | PASS, 12 packages                                |
| `pnpm architecture:check`                                    | PASS, 121 service sources                        |
| `pnpm forbidden-files:check`                                 | PASS                                             |
| `pnpm license:check`                                         | PASS; five release blockers pending legal review |
| `pnpm sbom:generate`                                         | PASS                                             |
| `pnpm build`                                                 | PASS, 12 packages                                |
| `pnpm build:workers`                                         | PASS                                             |
| `docker compose -f deploy/docker-compose.yml config --quiet` | PASS                                             |

## Dependencies And Installation

- New dependencies: none.
- Agent installs: none.
- Phase 1 install record: `NOT_REQUIRED`; the clean baseline dependency mirror
  was reused and no lockfile changed.
- User install 1 after S8 rebase: `PENDING_USER_ACTION`.
- User install 2 final candidate install: `PENDING_USER_ACTION`.
- `pnpm-lock.yaml` was not edited.
- OpenAPI generated artifacts were not edited.

The W3 two-install requirement cannot be completed until the S8 merge SHA and
latest `origin/main` are supplied.

## Real / Mock / External

Real verified:

- Mongo replica-set transactions for synonym config, mappings, ObjectRef, Job,
  Outbox, Audit, CAS and idempotency.
- Redis/pgvector/MinIO/Next build and regression E2E from the existing W3
  baseline.
- Browser rendering, axe, keyboard and responsive geometry for the S9 test-only
  workbench.

Contract-tested only in phase 1:

- S6 rebuild/index Port staging and finalization.
- S7 integration of query expansion.
- Shared worker dispatch for `synonym_rebuild`.

External unverified:

- Real embedding model/profile switching through a production provider.
- Production object storage and IAM.
- W3 candidate CI and personA/personB evidence.

## Post-Rebase Work Still Required

- Fetch and rebase only after the user supplies the S8 merge SHA and latest
  `origin/main`.
- Preserve S8 vision embedding, caption, Deep, Images/Search UI, dependencies,
  tests, registries and generated artifacts.
- User installs dependencies after rebase; Coding commits only pnpm's final
  lockfile.
- Generate OpenAPI with `pnpm openapi:generate` and register the eight S9
  operations.
- Wire query expansion into the existing S7 embedding/full-text path so both
  recall channels receive identical expanded text.
- Wire `synonym_rebuild` into the shared S6 `knowledge-rebuild` handler and
  complete shared staging/finalization.
- Add Synonyms route, navigation, i18n, query keys, web/app barrels and shared
  shell integration.
- Reach runtime `110 / deferred 10` and capability `53 / 49`.
- Freeze `candidateSha`, run full S9/W3 gates, notify the user to push and hand
  the SHA to personB, then collect both same-SHA evidence files.

## Known Risks

- The generated deferred route metadata currently reports multipart synonym
  upload/update `idempotent=false` because the builder only inspects inline
  parameters, while the source OpenAPI references the required
  `IdempotencyHeader`. The S9 operation handler itself validates the header.
  This must be rechecked and corrected through authorized generated-contract
  work after rebase; generated files were not manually edited here.
- The real shared S6 staging/finalization implementation is not wired in phase 1;
  tests prove the Port contract, failure ordering and compensation boundary.
- S7 has not yet received the query extension hook; tests prove the pure module
  and service cache/version behavior.
- Five production dependency-license blockers remain pending legal review.
- No production external model credentials were available.

## Conclusion

`PHASE1_PASS_WAITING_FOR_S8_MERGE_SHA`
