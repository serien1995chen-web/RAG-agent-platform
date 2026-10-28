# S8 Image And Deep RAG Stage Report

## Status

- Stage result: `S8_BRANCH_PASS_PENDING_S9_REBASE`.
- Wave / stage / owner: `W3 / S8 / personB`.
- W3 base: `origin/main@13fa0e9be84edd33ea5cc5413d64282c126dd117`.
- S8 implementation candidate: `9ed48366872bfa35271a4d3ce77f1ef84de06eec`.
- Evidence commit: `ae80ba26e0664cdd928a48359ec16f9b3d3c4c4c`.
- PersonA candidate SHA: `NOT_PROVIDED`.
- Pushed personA branch: `NOT_PROVIDED`.
- S8 merge SHA: `NOT_PROVIDED`.
- Parallel S9 candidate / evidence: `NOT_PROVIDED`.
- W3 result: `NOT_RUN`, not complete.

## Task Coverage

| Task     | Result | Primary proof                                                                       |
| -------- | ------ | ----------------------------------------------------------------------------------- |
| `S8-T01` | PASS   | Image Source and `purpose=image` ObjectRef integration, caption child, image policy |
| `S8-T02` | PASS   | Caption/vision embedding unit and real pgvector/Mongo integration                   |
| `S8-T03` | PASS   | Image search fusion, ACL, ticket and citation tests                                 |
| `S8-T04` | PASS   | Chunking settings, paragraph enhancement and auto/image index tests                 |
| `S8-T05` | PASS   | Deep budget, rounds, stop reasons, ACL and citation tests                           |
| `S8-T06` | PASS   | Images/Deep UI, three viewports, axe, overflow and safe errors                      |
| `S8-T07` | PASS   | Full final gate matrix and acceptance evidence                                      |

## Contract And Runtime

| Item                                         | Result                                                   |
| -------------------------------------------- | -------------------------------------------------------- |
| Contract                                     | `92 paths / 120 operations / 139 schemas / 8 parameters` |
| Runtime / deferred                           | `102 / 18`                                               |
| Runtime/deferred intersection / union        | `0 / 120`                                                |
| S8 operations runtime                        | `API-SEARCH-IMAGE`, `API-SEARCH-DEEP`                    |
| S9 synonym operations deferred               | `8 / 8`                                                  |
| Capability inventory                         | `73 total = 12 BASE + 57 DATA + 4 EXCLUDED`              |
| Capability implemented / closed              | `51 / 47`                                                |
| Mongo collections / vector profiles / queues | `23 / 4 / 13`                                            |
| `DOWN-001...004`                             | remain `DATA`                                            |

S8 closes `MULTI-001`, `SEARCH-006`, `SEARCH-008` and `PARSE-005`.

## Final Gate Summary

| Gate                                         | Result                     |
| -------------------------------------------- | -------------------------- |
| OpenAPI generate/check                       | PASS                       |
| Inventory/runtime                            | PASS                       |
| Lint/format/typecheck                        | PASS                       |
| Architecture/forbidden files                 | PASS                       |
| Unit                                         | PASS, 22 tasks             |
| Contract                                     | PASS, 19 files / 93 tests  |
| Integration                                  | PASS, 27 files / 149 tests |
| Tenant                                       | PASS, 7 files / 16 tests   |
| Concurrency                                  | PASS, 7 files / 14 tests   |
| Fault                                        | PASS, 9 files / 33 tests   |
| E2E                                          | PASS, 11 files / 53 tests  |
| Application build                            | PASS                       |
| Worker build                                 | PASS                       |
| Default / AIProxy Compose config             | PASS                       |
| Real local Mongo/Redis/Postgres/MinIO health | PASS                       |
| SBOM/license                                 | PASS                       |

All final commands exited `0`. Detailed command outputs, log hashes, generated
artifact hashes and UI hashes are recorded in
[`s8-stage-evidence.md`](./s8-stage-evidence.md).

## Dependency

- User reported running `pnpm install` after the dependency-only pause.
- User installation timestamp and exit code: `NOT_SUPPLIED`.
- Coding Agent did not run `pnpm install/add/update/remove`.
- Installed dependency: `react-photo-view@1.2.7`, one `@kb/web` lineage.
- Lockfile SHA-256:
  `a12d7b5430abfb013b6af52dbabc6d6a30c0b96b4f6f48d1a4d0454b3a691e7f`.

## Provider State

- `REAL_VERIFIED`: local Mongo replica set, Redis, PostgreSQL/pgvector, MinIO,
  canonical HTTP app, ticket route and Chromium UI.
- `FIXTURE_VERIFIED`: VLM caption, ordered vision embedding, Deep planner/stop
  behavior and provider fault mappings.
- `EXTERNAL_UNVERIFIED`: production AIProxy VLM/embedding/rerank credentials,
  vendor vision capability and IAM/API-key scope.

## Evidence

- [S8 detailed evidence](./s8-stage-evidence.md)
- [S8 provider matrix](./s8-provider-matrix.md)
- [S8 dependency ledger](./s8-dependency-ledger.md)
- [S8 UI screenshots](./s8-ui)

## Remaining W3 Gate

The W3 personB gate has not run. To start it, the user must provide:

1. PersonA candidate SHA.
2. Pushed personA branch name.
3. S8 merge SHA.

Until then, W3 runtime `110/10`, Capability `53/49`, S9 synonym runtime and
same-SHA personA/personB evidence remain unverified. This report does not claim
W3 PASS.

## Risks

- Production Provider credentials and vendor vision capability remain external.
- The local Mongo test URI requires `directConnection=true` because of the
  replica set's Compose-hostname advertisement.
- Five pre-existing release-legal blockers remain for S11/legal disposition.
- This branch is local only and has not been pushed or opened as a PR.
