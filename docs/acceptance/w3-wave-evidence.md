# W3 Wave Evidence

## Decision

- Wave: `W3`.
- Stages: S8 image/deep RAG with parallel S9 synonym/rebuild.
- Branch: `feat/kb-s09-synonym-rebuild`.
- Candidate SHA: `a5768dfa008756a2695ac148b01476e7e3d72ad6`.
- Evidence commit SHA: `PENDING_DOCS_ONLY_EVIDENCE_COMMIT`.
- PersonA: `PASS`.
- PersonB: `PASS`.
- Wave result: `BOTH_LOCAL_GATES_PASS_PENDING_CI_AND_REVIEW`.

W3 is locally proven at one candidate. CI, Review and PR Review at the final
docs-only evidence commit remain required before declaring `W3_PASS`.

Evidence hashes:

- PersonA:
  `7a0f39cfd0ea2ebb0ab12081556d08e4770fcc6b3cbdaa19a06577ca17990179`.
- PersonB:
  `6d0561d2ec5ec3af63dc6536a5f9054fdbf40228737eb60fdb3b22f6e6447d3f`.
- PersonB evidence manifest:
  `08b04cf74638b38f53bd4da50b4f545b0a3c18424c9dd7b02abf27c499380558`;
  `56` entries.
- PersonB log manifest:
  `c37e6619e1ee9d08a3f9662c3dad283fb72561e632973b7ad8dbe6c081c06255`;
  `27` entries.

PersonB content is preserved byte-for-byte in
`docs/acceptance/w3-personB-gate.md`; personA did not rewrite or replace it.

The gate was reissued at the same candidate with formatting-only changes:

- `148` changed lines, all Markdown table rows;
- `0` non-table changed lines;
- Prettier `3.8.3` check passed under the repository `.prettierrc.cjs`;
- Prettier diff SHA-256:
  `88f19165c4e66b3cb8281e6e35ec19cfb64aa1ddcdf7d92ff52ab93f8ff518ae`;
- Prettier log SHA-256:
  `d3893f05668a9e2680c21546781bcce75f212c04a99fde298a64b30a95d49e4a`;
- final validation log SHA-256:
  `2706de3eb8ba8c78cc8b792e7203dcf10045037fdcf0e2da1fb2c7e22d12b45c`.

## Candidate

| Check                | Result                                                             |
| -------------------- | ------------------------------------------------------------------ |
| W3 baseline          | `13fa0e9be84edd33ea5cc5413d64282c126dd117`                         |
| S8 merge             | `9839b2a1005ce7fdf4558ea8d002ae1ab6dcadbd`                         |
| S8 merge parents     | `13fa0e9` and `1c55abb`                                            |
| Candidate            | `a5768dfa008756a2695ac148b01476e7e3d72ad6`                         |
| Candidate parent     | `03fc6f0a47d4aa9328cd78d54baea4fa3b05913b`                         |
| Candidate subject    | `fix(worker): resolve deployment runtime dependencies`             |
| Remote branch        | PASS, candidate SHA matches `origin/feat/kb-s09-synonym-rebuild`   |
| Ancestry             | PASS, W3 baseline and S8 merge are candidate ancestors             |
| Worktree             | PASS, tracked status empty before and after both gates             |
| Lockfile SHA-256     | `a12d7b5430abfb013b6af52dbabc6d6a30c0b96b4f6f48d1a4d0454b3a691e7f` |
| Test ID preservation | PASS, `140 -> 155` unique `TEST-*` IDs                             |

The superseded candidate `03fc6f0a...` personB `FAIL` evidence was not reused.
Its blocker was missing `yauzl` runtime resolution in the deployment worker.

## A / B Gate Agreement

| Fact                         | PersonA           | PersonB                       |
| ---------------------------- | ----------------- | ----------------------------- |
| Candidate                    | `a5768dfa...`     | `a5768dfa...`                 |
| Result                       | PASS              | PASS                          |
| Contract                     | `92/120/139/8`    | `92/120/139/8`                |
| Runtime / deferred           | `110 / 10`        | `110 / 10`                    |
| Runtime intersection / union | `0 / 120`         | `0 / 120`                     |
| S8 runtime                   | `2 / 2`           | `2 / 2`                       |
| S9 runtime                   | `8 / 8`           | `8 / 8`                       |
| DATA implemented / closed    | `53 / 49`         | `53 / 49`                     |
| `DOWN-001...004`             | `DATA`            | `DATA`                        |
| Canonical queues             | `13`              | `13`, live readiness verified |
| Mongo collections            | `23`              | `23`                          |
| Vector profiles              | `4`               | `4`                           |
| Dependency installation      | User install only | No installation               |

Both owners ran at the same candidate SHA. PersonB used a detached checkout.
PersonA used the supplied candidate branch. Both restored E2E-generated tracked
S8 acceptance screenshots to candidate bytes and preserved generated artifacts
outside the candidate.

## Commands

| Gate               | PersonA | PersonB |
| ------------------ | ------- | ------- |
| Lint               | PASS    | PASS    |
| Format             | PASS    | PASS    |
| Typecheck          | PASS    | PASS    |
| Architecture       | PASS    | PASS    |
| Forbidden files    | PASS    | PASS    |
| License            | PASS    | PASS    |
| SBOM               | PASS    | PASS    |
| OpenAPI check      | PASS    | PASS    |
| Contract inventory | PASS    | PASS    |
| Runtime check      | PASS    | PASS    |
| Unit               | PASS    | PASS    |
| Contract           | PASS    | PASS    |
| Integration        | PASS    | PASS    |
| Tenant             | PASS    | PASS    |
| Concurrency        | PASS    | PASS    |
| Fault              | PASS    | PASS    |
| E2E                | PASS    | PASS    |
| Full `pnpm test`   | PASS    | PASS    |
| Build              | PASS    | PASS    |
| Worker build       | PASS    | PASS    |
| Compose config     | PASS    | PASS    |

Gate counts:

```text
Unit         22 tasks, 349 tests
Contract     20 files, 96 tests
Integration  22 tasks, 196 tests
Tenant       8 files, 17 tests
Concurrency  8 files, 16 tests
Fault        10 files, 34 tests
E2E          14 files, 58 tests
```

## Worker Gate

The previous personB failure was reproduced at `03fc6f0`: the deployment
worker exited before readiness because `require('yauzl')` could not resolve.

The new candidate:

- derives the workspace root from the generated worker's `import.meta.url`;
- adds `node_modules/.pnpm/node_modules` and root `node_modules` to formal
  worker `NODE_PATH`;
- sets the same paths in the Docker runner;
- adds a contract regression assertion.

Both owners verified the deployment-equivalent command without manually setting
`NODE_PATH`:

```text
node projects/app/dist/workers/worker.mjs
```

Observed result:

```text
ready marker present
knowledge_queue_meta=13
knowledge_queue_stalled_check=13
clean SIGTERM shutdown
no remaining worker process
```

PersonB worker runtime log SHA-256:
`63678074d15aeb76256354702889dd3c8ca9dec7d486368aa1d3cea8c544dd10`.

## Contract / Runtime / Capability

- Contract: `92 paths / 120 operations / 139 schemas / 8 parameters`.
- Runtime / deferred: `110 / 10`.
- Runtime/deferred intersection: `0`; union: `120`.
- S8 runtime: `API-SEARCH-IMAGE`, `API-SEARCH-DEEP`.
- S9 runtime: all eight `API-SYNONYM-*` operations.
- Remaining deferred: exactly ten S10 operations.
- Canonical queues: `13`.
- Mongo collections: `23`.
- Vector profiles: `768 / 1024 / 1536 / 3072`.
- Capability inventory: `73 total / 12 BASE / 57 DATA / 4 EXCLUDED`.
- W3 implemented / closed: `53 / 49`.
- `DOWN-001...004` remain `DATA`.

Capability derivation:

- W2: `47 implemented / 43 closed`.
- S8 adds `MULTI-001`, `SEARCH-006`, `SEARCH-008`, `PARSE-005`.
- S9 adds `SEARCH-003`, `TRAIN-006`.
- Result: `47 + 4 + 2 = 53`; `43 + 4 + 2 = 49`.

S9 runtime operations:

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

## C4 / C5 / C6

C4:

- S8 caption, vision embedding, image search, mixed image/text search and Deep
  RAG remain present.
- Images and Search/Deep real pages passed responsive and accessibility gates.
- No S8 test, UI, dependency, registry or generated artifact was removed.

C5:

- S9 query extension feeds the S7 query pipeline while retaining the original
  query and one identical expanded query for embedding and full-text recall.
- Synonym rebuild uses S6 rebuild/index Ports and S7 pipeline integration; S9
  does not write vector/full-text/S7 candidates directly.
- FileVersion switching, failure rollback, 30-day cleanup and model/source/index
  rebuild facts are recorded in Jobs.

C6:

- Workspace predicates, Space/read/manage checks and final Source ACL remain
  authoritative.
- S9 audits contain versions, counts, IDs and safe error codes, not full
  synonym files or complete term lists.
- Job, Outbox and Audit facts remain consumable by S10.
- No S10 API Key, usage, ops page or cleanup admin implementation was added.

## Shared Files And S8 Preservation

The W3 union preserves S8 and S9 changes in:

- OpenAPI builder, runtime/deferred/route registries and generated clients;
- S5 model bindings, S6 processing Ports/repository/worker dispatch;
- S7 search application/Ports/pipeline/repository;
- knowledge application/runtime/barrels/API handler;
- web shell, i18n, query keys, web/app barrels and shared route;
- queue/Job dispatch and pgvector/full-text Ports.

Important S8 preservation facts:

- No deleted path exists from W3 baseline or S8 merge to candidate.
- Images, Deep, caption, vision embedding, real-page E2E and dependencies remain.
- Tracked S8 acceptance PNGs match pre-test hashes.
- S8 blocked test IDs were executed by both owners.

## Dependencies

- Coding Agent installations: `0`.
- User installation 1: S8 dependency pause.
- User installation 2: post-rebase S9 `pnpm install`, exit `0`.
- Final lockfile SHA-256:
  `a12d7b5430abfb013b6af52dbabc6d6a30c0b96b4f6f48d1a4d0454b3a691e7f`.
- PersonB used a hardlinked dependency view with the same lockfile hash and did
  not run package-manager installation.
- No lockfile, OpenAPI generated file or dependency catalog was hand-edited.

## UI Evidence

- Synonyms, Images and Search/Deep passed at `360`, `768` and `1200`.
- Serious/critical axe violations: `0`.
- Horizontal overflow: `<= 0`.
- Unexpected console/page errors: `0`.
- Keyboard focus and operation controls passed.
- Real Synonyms rebuild progress consumed the existing Job list.

PersonA Synonyms screenshots:

| Viewport | SHA-256                                                            |
| -------- | ------------------------------------------------------------------ |
| 360      | `37e9b8b6063256a7e2265ac9816f0df1a7536f1be88b3d8037f3176361ef9599` |
| 768      | `31ba156d28213d1e0b3bc1241c7db325e03345ff8d0af2106ee8a6faf9005481` |
| 1200     | `9881b6f1c45031dca9a5c1004cc1a23c062952bf824ec42fc4735a5653276b1e` |

PersonB Synonyms screenshots:

| Viewport | SHA-256                                                            |
| -------- | ------------------------------------------------------------------ |
| 360      | `bc9c5e439ba741d6e0d96907be2500d2d2d9784ec2a67c40bf5d7263110b034d` |
| 768      | `6157740aacf90a11cdf417790563c648e1f082e5f6e2239f9156f1c80c8bf09c` |
| 1200     | `59bb26918018bd0977e9e949c5f8e2cda0a0d02ba0e9ca9176423347f5983ea6` |

Screenshot bytes differ between independent runs, but both owners passed the
same layout, overflow, accessibility, keyboard and console/network assertions.

## Test IDs

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
TEST-SEARCH-006-BLOCK
TEST-SEARCH-008-BLOCK
TEST-MULTI-001-BLOCK
TEST-PARSE-005-BLOCK
```

## Real / Fixture / External

`REAL_VERIFIED`:

- Mongo replica-set transactions, Redis/BullMQ, PostgreSQL/pgvector and MinIO;
- canonical HTTP app, real worker readiness and Chromium;
- S8/S9 repository, rebuild, tenant, ACL, concurrency and fault paths;
- real Synonyms, Images and Search/Deep pages.

`FIXTURE_VERIFIED`:

- AIProxy mock, VLM caption, vision embedding and Deep planner fixtures;
- deterministic synonym parsing/expansion/rebuild fixtures.

`EXTERNAL_UNVERIFIED`:

- production AIProxy VLM/embedding/rerank credentials;
- vendor vision capability and FastGPT cloud behavior;
- IAM/API-key production scope and lifecycle.

## Risks

- CI at the docs-only evidence commit is pending.
- Review and PR Review are pending; they must bind the final CI URL.
- Five dependency/license items remain release blockers for S11/legal
  disposition.
- Production cloud Providers remain `EXTERNAL_UNVERIFIED`.
- A prior parallel integration run exposed one archive retry timing failure.
  It passed standalone, and the new candidate integration plus full `pnpm test`
  passed; it remains a residual flake risk.

## Evidence Boundary

The evidence commit must contain only the following files under
`docs/acceptance/**`:

```text
w3-personA-gate.md
w3-personB-gate.md
w3-wave-evidence.md
```

It must not change code, lockfile, generated files, dependencies or runtime
configuration. Any such change invalidates both gates and requires a new
candidate and both owners to rerun.

## Remaining Closure

1. Commit the three evidence files to create `evidenceCommitSha`.
2. Push that commit and run CI on the final evidence head.
3. Complete Review and PR Review, binding the CI URL.
4. Only then may the PR declare W3 complete.
