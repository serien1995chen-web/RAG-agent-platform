# W3 personB Gate

## Decision

Status: `PASS`

Scope: `W3 personB read-only gate`

Wave closure: `PERSONB_PASS_PENDING_EVIDENCE_COMMIT_AND_CI`

This document certifies only the personB gate at the candidate below. It does
not rewrite or replace personA evidence and does not independently declare W3
complete.

## Identity

- Wave: `W3`
- Stage under review: `S9 / personA`, with parallel `S8 / personB` merged
- Candidate owner: `personA`
- Gate owner: `personB`
- Branch: `feat/kb-s09-synonym-rebuild`
- Candidate SHA: `a5768dfa008756a2695ac148b01476e7e3d72ad6`
- Candidate parent: `03fc6f0a47d4aa9328cd78d54baea4fa3b05913b`
- W3 baseline: `13fa0e9be84edd33ea5cc5413d64282c126dd117`
- S8 merge SHA: `9839b2a1005ce7fdf4558ea8d002ae1ab6dcadbd`
- S8 merge parents: `13fa0e9be84edd33ea5cc5413d64282c126dd117`,
  `1c55abb2fa1ecc5bdafaa2d3d3a26f05df24f4c7`
- Evidence commit SHA: `NOT_CREATED`
- Worktree: `/home/archer/RAG-agent-platform-w3-personB-a5768dfa`
- Git state: detached checkout at the supplied candidate SHA
- Remote branch head: `a5768dfa008756a2695ac148b01476e7e3d72ad6`

PersonB did not edit source, rebase, install dependencies, push, create a PR,
merge, or commit on the candidate branch. E2E-generated artifacts were moved
outside the candidate. Tracked `docs/acceptance` content was restored byte-for-
byte and matches the pre-test content-hash manifest.

## Preflight

| Check                          | Result                                                                   |
| ------------------------------ | ------------------------------------------------------------------------ |
| `git rev-parse HEAD`           | PASS: `a5768dfa008756a2695ac148b01476e7e3d72ad6`                         |
| Candidate parent               | PASS: `03fc6f0a47d4aa9328cd78d54baea4fa3b05913b`                         |
| W3 baseline ancestor           | PASS: exit `0`                                                           |
| S8 merge ancestor              | PASS: exit `0`                                                           |
| Remote branch equals candidate | PASS                                                                     |
| Worktree before gate           | PASS: empty `git status --porcelain`                                     |
| Worktree after gate            | PASS: empty `git status --porcelain`                                     |
| Final `git diff --check`       | PASS: exit `0`                                                           |
| Live worker after gate         | PASS: no process, readiness marker absent                                |
| Candidate lockfile             | PASS: `a12d7b5430abfb013b6af52dbabc6d6a30c0b96b4f6f48d1a4d0454b3a691e7f` |
| Dependency-view lockfile       | PASS: same SHA-256 as candidate lockfile                                 |

The only candidate delta from `03fc6f0` is commit `a5768df`:

- `deploy/Dockerfile`
- `projects/app/tsdown.workers.config.ts`
- `test/contract/s6-job-index-contract.test.ts`
- `docs/acceptance/s9-synonym-rebuild-stage.md`

## Plan And Inputs

| Input                            | SHA-256                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| `S9-实现方案与审查标准.md`       | `fb52bf9991964ca23e79e1aa1ec4b8ba85c80f4488691c83f97b645286a56cb0` |
| `KnowledgeBase-System-Design.md` | `8e5e7300c651c4fe0478b87fc3572add52f95c3e49c8f15700b45bb8c690a26d` |
| Task breakdown                   | `11aa3693599759ef969c9f6ad85ae61da8fd925940baacfb17a1c5c389e2fb6e` |
| `coding.md`                      | `6160d409fa57ea0de6bef24777979492f0ed10520070032ac5df578211ef8cc9` |

Plan checks:

- Seven Task headings `S9-T01...S9-T07`.
- Each Task has fields `1...12`; every field count is `7`.
- Thirty-two unique atomic Step IDs.
- All eight `API-SYNONYM-*` Operations are present.
- C5, C6 and the post-rebase shared-file section are present.
- Plan audit exits `0`.

## Dependency View

- User/personA records the required post-rebase user `pnpm install`.
- PersonB executions of `pnpm install/add/update/remove`: `0`.
- Candidate lockfile and dependency-view lockfile are identical.
- The dependency view uses hardlinks from the prior install with the same lock
  file and relative workspace symlinks resolving into this candidate.
- `pnpm list -r --depth 0 --json` returns 13 projects with no stderr.
- No lockfile files were edited.

## Environment

```text
OS: Ubuntu 22.04 WSL2 / x86_64
Node: v22.23.2
pnpm: 10.33.4
Git: 2.34.1
Docker: 29.6.2
Docker Compose: 5.3.1
Timezone: Asia/Shanghai
```

Local infrastructure:

- MongoDB `rs0` accepted a ping.
- Redis returned `PONG`.
- PostgreSQL/pgvector reported `accepting connections`.
- MinIO live health endpoint returned success.
- Default and AIProxy Compose configurations rendered successfully.

## Contract And Runtime

| Check                                        | Result                                                         |
| -------------------------------------------- | -------------------------------------------------------------- |
| Contract                                     | PASS: `92 paths / 120 operations / 139 schemas / 8 parameters` |
| Runtime / deferred                           | PASS: `110 / 10`                                               |
| Runtime-deferred intersection / union        | PASS: `0 / 120`                                                |
| S8 runtime Operations                        | PASS: `API-SEARCH-IMAGE`, `API-SEARCH-DEEP`                    |
| S9 runtime Operations                        | PASS: all eight `API-SYNONYM-*`                                |
| Deferred Operations                          | PASS: exactly ten S10 Operations                               |
| Mongo collections / vector profiles / queues | PASS: `23 / 4 / 13`                                            |
| Capability inventory                         | PASS: `73 = 12 BASE + 57 DATA + 4 EXCLUDED`                    |
| W3 implemented / closed                      | PASS by derivation: `53 / 49`                                  |
| `DOWN-001...004`                             | PASS: all remain `DATA`                                        |

Capability derivation:

- W2 evidence records `47 implemented / 43 closed`.
- S8 closes `MULTI-001`, `SEARCH-006`, `SEARCH-008`, `PARSE-005`.
- S9 closes `SEARCH-003`, `TRAIN-006`.
- Result: `47 + 4 + 2 = 53 implemented`; `43 + 4 + 2 = 49 closed`.

S8 preservation:

- No deleted path exists in `W3 base..candidate` or `S8 merge..candidate`.
- S8 caption, image search, image index, Deep search, Images UI and real-page
  E2E files all remain.
- `TEST-SEARCH-006-BLOCK`, `TEST-SEARCH-008-BLOCK`, `TEST-MULTI-001-BLOCK` and
  `TEST-PARSE-005-BLOCK` remain present and executed.
- `s8_caption_executor_missing` is absent.
- Unique `TEST-*` IDs remain `155`, including all prior S8 and S9 IDs.

## Worker And Queue

Worker build passes. The bundled worker banner derives workspace root from
`import.meta.url`, not `process.cwd()`, and adds:

```text
node_modules/.pnpm/node_modules
node_modules
```

The Docker runner also explicitly sets:

```text
NODE_PATH=/app/node_modules/.pnpm/node_modules:/app/node_modules
```

The deployment-equivalent verification ran with `NODE_PATH` unset by personB,
using the candidate-distributed worker banner:

```text
READY_MARKER_PRESENT
ready
queue_meta_count=13
stalled_check_count=13
WORKER_SHUTDOWN_CLEAN
```

The worker reached `workers.ready` with exactly the 13 canonical
`knowledge-*` queues, including `knowledge-caption` and
`knowledge-rebuild`. SIGTERM removed the readiness marker and no worker process
remained.

The contract regression
`keeps deployment worker dependency resolution explicit` passes and asserts the
workspace-root banner plus the Docker `NODE_PATH`.

## Test Matrix

| Gate                            | Exit | Result                                            |
| ------------------------------- | ---: | ------------------------------------------------- |
| `pnpm test:unit --force`        |    0 | Turbo `22 / 22`; service `106` unit tests         |
| `pnpm test:contract`            |    0 | `20` files / `96` tests                           |
| `pnpm test:integration --force` |    0 | Turbo `22 / 22`; service `29` files / `163` tests |
| `pnpm test:tenant`              |    0 | `8` files / `17` tests                            |
| `pnpm test:concurrency`         |    0 | `8` files / `16` tests                            |
| `pnpm test:fault`               |    0 | `10` files / `34` tests                           |
| `pnpm test:e2e`                 |    0 | `14` files / `58` tests                           |
| `pnpm test`                     |    0 | Full sequence passed                              |
| `pnpm build`                    |    0 | `12 / 12` packages                                |
| `pnpm build:workers`            |    0 | Worker bundle and assets generated                |
| `pnpm lint`                     |    0 | PASS                                              |
| `pnpm format:check`             |    0 | PASS                                              |
| `pnpm typecheck --force`        |    0 | `12 / 12` packages                                |
| `pnpm architecture:check`       |    0 | `133` service sources / `12` packages             |
| `pnpm forbidden-files:check`    |    0 | `544` files                                       |
| `pnpm license:check`            |    0 | PASS; five release-legal blockers remain          |
| `pnpm sbom:generate`            |    0 | PASS                                              |

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
TEST-SEARCH-006-BLOCK
TEST-SEARCH-008-BLOCK
TEST-MULTI-001-BLOCK
TEST-PARSE-005-BLOCK
```

## Real S7 / S9 Integration

- `s7-semantic-search.test.ts` passes with S9 query expansion enabled.
- Integration verifies original-query retention, same expanded text for
  embedding/full-text, cache/version revalidation, disabled fallback, 4096
  fallback and multi-Space ordering.
- `s09-synonym-repository.test.ts` and S6 rebuild tests pass against real Mongo,
  Redis, PostgreSQL/pgvector and MinIO.
- Final ACL and tenant tests remain green.
- S8 Images/Deep real-page E2E remains green.

## UI Evidence

Real Synonyms page screenshots generated outside the candidate:

| Viewport | Size        | SHA-256                                                            |
| -------- | ----------- | ------------------------------------------------------------------ |
| 360      | `360x1120`  | `bc9c5e439ba741d6e0d96907be2500d2d2d9784ec2a67c40bf5d7263110b034d` |
| 768      | `768x1000`  | `6157740aacf90a11cdf417790563c648e1f082e5f6e2239f9156f1c80c8bf09c` |
| 1200     | `1200x1000` | `59bb26918018bd0977e9e949c5f8e2cda0a0d02ba0e9ca9176423347f5983ea6` |

The real-page suite checks axe serious/critical `0`, horizontal overflow `<= 0`,
console/page errors `0`, keyboard interaction and operation controls.

S8 tracked Images/Deep acceptance PNGs remain unchanged:

```text
ca186bd0b371fdec7067ef15803965eec7b83fe51b77b0603ac9df419c52e889  s8-deep-1200.png
a17262e2393e12fb6b1d2ad0fd69eb982c22b9da80357cfd8636050d46dc819e  s8-deep-360.png
4e41e264b70d3381456273237e6798649cbae10bc8243ed8a6814e1ed96533c1  s8-deep-768.png
eb4df426268e2d595bd577e51d8c8baf7eeb58874e44a6133bf83039568410e9  s8-images-1200.png
ab6d9a67aa9a680e915e3e1f061f598d0d78eba28407e668e8c3325cab6d9a07  s8-images-360.png
63e7c920f9564fc7acdf89d287aa2bbb9f91676db310626315696a25b69180f1  s8-images-768.png
```

`docs/acceptance` content hashes before and after E2E are identical:
`5620622c992d052f90a6ed3e191217abf8bc221df8721669d0d5d6821b599b76`.

## PersonA Evidence

- Supplied path:
  `\\wsl.localhost\Ubuntu-22.04\home\serien\RAG-agent-platform-s09\docs\acceptance\w3-personA-gate.md`
- Supplied SHA-256:
  `7a0f39cfd0ea2ebb0ab12081556d08e4770fcc6b3cbdaa19a06577ca17990179`
- PersonB local access to the personA worktree: `UNREADABLE`.
- PersonB did not rewrite or replace personA evidence.

W3 closure still requires personA to accept this file unchanged, create the
docs-only evidence commit, push it, and obtain CI/Review/PR Review on the final
head.

## Provider State

- `REAL_VERIFIED`: local Mongo replica set, Redis, PostgreSQL/pgvector, MinIO,
  canonical HTTP app and Chromium.
- `FIXTURE_VERIFIED`: VLM caption, vision embedding, Deep planner, S9 synonym
  parsing/expansion/rebuild and AIProxy mock.
- `EXTERNAL_UNVERIFIED`: production AIProxy VLM/embedding/rerank credentials,
  vendor vision capability, external FastGPT cloud behavior and IAM/API-key
  scope.

## Command Logs

All logs are under
`/home/archer/w3-personB-evidence-a5768dfa/logs/`.

| Command                             | Exit | Log SHA-256                                                        |
| ----------------------------------- | ---: | ------------------------------------------------------------------ |
| Plan audit                          |    0 | `35864c99e75a635c452b7409b0e24b7511dc76c244b66c0445e526da4800a828` |
| OpenAPI generate                    |    0 | `affe937792a2a2e1508dc52bc5b7f4c32e3b14d5fb32ca22b08d3ae288c50474` |
| OpenAPI check / inventory / runtime |    0 | `bf9f3afa786956ae87cf40b45e54166611ba95a5ea6e660482f66d4c96fdff2e` |
| Static quality                      |    0 | `377d39bec51559c3c2b0bb7742e3101698c178a1c0dc04cc4b472a16eefdb47c` |
| SBOM / license                      |    0 | `37e524734f681533aa09291a2089048ab2d2846399aa5ee48a98ffbf5b586375` |
| Unit                                |    0 | `568643da424bfce709e59c81c25c0e0703d7b09532f166d7b088ce8356377bcc` |
| Contract                            |    0 | `f714a44c603d76c2353bd1fb318e8c5940daad00b589939a5d33fa14a4f673c3` |
| Integration                         |    0 | `6d947c5552055e4d6b8db9103086f8cb085087c0113f623c3b090b8b27bbcf91` |
| Full `pnpm test`                    |    0 | `7aec25a691eb8cb222c775412fbc7f8b9ede10e95f1cfee5efc7b0ec261f1f78` |
| Build                               |    0 | `ca42ba92330b0f0edf41af75ea4d8f7bbfb2ffb0c4059b0102efb69326895663` |
| Worker build                        |    0 | `563be100f955aea726ef61431c3ad9a006b2e0464bf546126fb129edf1a125d1` |
| Worker exact runtime                |    0 | `63678074d15aeb76256354702889dd3c8ca9dec7d486368aa1d3cea8c544dd10` |
| Worker config assertions            |    0 | `2f3829a8fd4b43e6bb982ebf1472673e4f6c6475bb427a82517808061be4311d` |
| Operation audit                     |    0 | `6a53600022b541202c249b779cdffb84d92ed2edab678a7123cf14a0397660d1` |
| Preservation/capability audit       |    0 | `907da6ef352828147a332b1c20868d27dc6d93fad0f119638611f88c722a9ab9` |
| Compose config                      |    0 | `ece257fcb66ddfcd6c094ce90e06c552c7b73c0826fddd5fe18a36776a64da5b` |
| Local infrastructure health         |    0 | `ba43b0afca5f0de787bdd28509e9a6702cee3edcbce7dfb89f01f5796e41150b` |
| Final clean/ancestry state          |    0 | `1bf6e9df04ddec41e949db543fe93bfb1c62276e7b6270f8b8e7307defee30de` |

## Risks

- Five dependency/license items remain release blockers for S11/legal
  disposition; they do not block this CI gate.
- Production cloud Providers remain `EXTERNAL_UNVERIFIED`.
- PersonA evidence content could not be read from the personA worktree by
  personB; only the supplied SHA is recorded.
- Evidence-only commit, CI, Review and PR Review are still required before W3
  can be declared complete.

## Conclusion

`PASS` for the personB gate at candidate
`a5768dfa008756a2695ac148b01476e7e3d72ad6`.

This is not a W3 completion claim. PersonA must accept this evidence unchanged,
create the docs-only evidence commit, push it, and pass CI/Review/PR Review.
