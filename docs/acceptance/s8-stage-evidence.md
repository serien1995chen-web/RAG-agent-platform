# S8 Image And Deep RAG Stage Evidence

## Status

- Status: `S8_BRANCH_PASS_PENDING_S9_REBASE`.
- Wave / stage / owner: `W3 / S8 / personB`.
- Base SHA: `13fa0e9be84edd33ea5cc5413d64282c126dd117`.
- Implementation candidate SHA: `9ed48366872bfa35271a4d3ce77f1ef84de06eec`.
- Branch: `feat/kb-s08-image-deep-rag`.
- Worktree: `/home/archer/RAG-agent-platform-w3-s8-personB`.
- Local commit policy: local commit only; not pushed and no PR created.
- W3 final status: not claimed. PersonA candidate and S9 rebase are still required.

## Inputs And Environment

| Input / runtime        | Value                                                              |
| ---------------------- | ------------------------------------------------------------------ |
| S8 plan SHA-256        | `7aeb1dd342fad91c09421fe5de510e3c16b2ae7fa188cbe1b5622dbdf8493e6e` |
| System design SHA-256  | `8e5e7300c651c4fe0478b87fc3572add52f95c3e49c8f15700b45bb8c690a26d` |
| Task breakdown SHA-256 | `11aa3693599759ef969c9f6ad85ae61da8fd925940baacfb17a1c5c389e2fb6e` |
| Coding rules SHA-256   | `6160d409fa57ea0de6bef24777979492f0ed10520070032ac5df578211ef8cc9` |
| OS / architecture      | Ubuntu 22.04 WSL2 / `x86_64`                                       |
| Node                   | `v22.23.2`                                                         |
| pnpm                   | `10.33.4`                                                          |
| Git                    | `2.34.1`                                                           |
| Docker server          | `29.6.2`                                                           |

## Dependency Installation

- The user reported running `pnpm install` once after the dependency-only pause.
- Installation timestamp and exit code were not supplied.
- The installed state was verified: `react-photo-view@1.2.7`, one catalog lineage,
  lockfile SHA-256 `a12d7b5430abfb013b6af52dbabc6d6a30c0b96b4f6f48d1a4d0454b3a691e7f`.
- The Coding Agent did not run `pnpm install/add/update/remove`.
- The Coding Agent did not hand-edit `pnpm-lock.yaml`.

## Final Gate Matrix

All listed commands exited `0`. Logs are under
`/home/archer/w3-s8-evidence-20261028/`; hashes bind the final run.

| Command                                               | Exit | Key result                                                  | Log SHA-256                                                        |
| ----------------------------------------------------- | ---: | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `pnpm openapi:generate`                               |    0 | `92/120/139`, runtime `102`, deferred `18`                  | `02817b3592e3f395d59a13074453fda43b86efb2fa8c0b58e160e5ba7d9daf51` |
| `pnpm openapi:check`                                  |    0 | `92 paths / 120 operations / 139 schemas`                   | `9e15ded3e0cb63b9c1543adfdac7075857d183171f063a0dc42e2df3899bfeeb` |
| `pnpm knowledge:inventory`                            |    0 | `23/4/13`, runtime `102/18`                                 | `14c7db46062e49b78d9e0384e4dc17c0e53e92deec9696f6643eb466b8a35ff7` |
| `pnpm knowledge:check-runtime`                        |    0 | intersection `0`, union `120`, old page route `0`           | `1db7b402a19e866980996ba8ccb2ff1925221630cc81f9349bee6d489e8ae0e3` |
| `pnpm lint`                                           |    0 | ESLint passed                                               | `f744a702bab6367029ba9637d5f23714c5a0fc4b9de1ba6bf924791088988022` |
| `pnpm format:check`                                   |    0 | Prettier passed                                             | `dd3bbf892dd33686f22acfd9d12c3b75cfc8b086504ec7933a363152741298c9` |
| `pnpm typecheck --force`                              |    0 | `12/12` packages                                            | `2cf7fdc948ca8e269f97cb8f92166f1d0d2aa8ffcd272f45ea2df1aaf8237e52` |
| `pnpm architecture:check`                             |    0 | `123` service files, `12` packages                          | `9813d1dbc44482ec1676d0d94d1fb31c01fbbe91da60a94bc5bbeed5bfca5273` |
| `pnpm forbidden-files:check`                          |    0 | `508` files, no forbidden source                            | `818832b8d110aef664a5be108116eddb01a54038caa39438fb229a8e08b928f3` |
| `pnpm test:unit --force`                              |    0 | `22/22` tasks                                               | `f263913552cf34d0a06986d57d872d62359fe26ee53130dbf6b966512365bcae` |
| `pnpm test:contract`                                  |    0 | `19` files, `93` tests                                      | `f68ef1830eb4ddeafccb2aeebd28f5c2d529c511c99ad6e2631c6d78bcde01a3` |
| `pnpm test:integration --force`                       |    0 | `27` files, `149` tests                                     | `de810fe4efb4dd3b67d12e3344ecc87fcab55661e3a0248cc8a9077b00f7984f` |
| `pnpm test:tenant`                                    |    0 | `7` files, `16` tests                                       | `c473aad0d8c32651a7fef1c3155d684aaf6e6bb2cbefadd45562490d09b42bd4` |
| `pnpm test:concurrency`                               |    0 | `7` files, `14` tests                                       | `b51759f20463213b3441e68eb0817e7cd7822fab63c7416f7c8831a300847b19` |
| `pnpm test:fault`                                     |    0 | `9` files, `33` tests                                       | `bd2fac608bada825b888a8b75246092d963bccb5df01da210ba2d4d1c2eef885` |
| `pnpm test:e2e`                                       |    0 | `11` files, `53` tests                                      | `397f936e12fa1a5d612dd5c14758b412fa31577287041b9fe05f817553cac2b2` |
| `pnpm build --force`                                  |    0 | `12/12` packages; Images/Search routes built                | `3c10b1f736db371833e67c770f3f4cab2aa4afa15ff18798c421aaebce316381` |
| `pnpm build:workers --force`                          |    0 | worker bundle built; `knowledge-caption` remains registered | `f81413a5d83feb897f8aba3b58ca7a4be3b1281adec2e860438d618558d9fc1d` |
| `docker compose ... config --quiet`                   |    0 | default profile valid                                       | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docker compose --profile aiproxy ... config --quiet` |    0 | AIProxy profile valid                                       | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| Compose `up -d --wait --pull never`                   |    0 | Mongo, Redis, pgvector, MinIO healthy                       | `485f4833c697b3d86c67e72e580dd3e915432677078f19eaf64ebfa2aaf8802b` |
| `pnpm sbom:generate`                                  |    0 | `160` direct, `1639` transitive, `12` workspaces            | `bbf252e81cafe277fa9156dd32e4179988eadc3e8bd36fa382ef1d44505c22f4` |
| `pnpm license:check`                                  |    0 | `160` catalog, `950` production components                  | `0d4d67e1a0cae29e5ec2bdd82e0eba7bb36dff15e13e75619711e2a9ee314623` |

The first integration attempt used the CI URI without `directConnection=true`
and failed during Mongo topology discovery before tests ran. The same command
then passed with the local direct-connection adjustment; no test was skipped or
weakened.

## Contract, Runtime And Capabilities

| Gate                                  | Result                                                   |
| ------------------------------------- | -------------------------------------------------------- |
| Contract                              | `92 paths / 120 operations / 139 schemas / 8 parameters` |
| Runtime / deferred                    | `102 / 18`                                               |
| Runtime-deferred intersection / union | `0 / 120`                                                |
| S8 runtime operations                 | `API-SEARCH-IMAGE`, `API-SEARCH-DEEP`                    |
| S9 synonym operations                 | all 8 remain deferred                                    |
| Mongo collections                     | `23`                                                     |
| pgvector profiles                     | `4`                                                      |
| BullMQ queues                         | `13`                                                     |
| Capability inventory                  | `73 = 12 BASE + 57 DATA + 4 EXCLUDED`                    |
| Implemented / closed Capabilities     | `51 / 47`                                                |

Capability derivation: W2 closed at `47 implemented / 43 closed`; S8 closes
`MULTI-001`, `SEARCH-006`, `SEARCH-008` and `PARSE-005`, producing
`51 implemented / 47 closed`. `DOWN-001...004` remain `DATA`.

## S8 Behavior Evidence

| Task     | Evidence                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `S8-T01` | Image Source, same-transaction `purpose=image` ObjectRef, caption child, no parse child, max 10 images and 20 MiB policy                   |
| `S8-T02` | VLM caption, ordered text/image embedding input, two indexes, source version/model/prompt evidence, one Mongo CAS, partial states          |
| `S8-T03` | Caption `0.3` + image vector `0.7`, text `1.0` + image block `0.7`, final ACL, controlled ticket, persisted citation, no object key        |
| `S8-T04` | Complete strict ChunkingSettings, paragraph enhancement, auto indexes, document image index, existing chunk/QA pipeline reuse              |
| `S8-T05` | `maxRounds<=3`, up to 5 queries/round, `5000/12000` defaults, five stop reasons, final once-only citation, replay via existing idempotency |
| `S8-T06` | Images page, per-Source segment status, safe react-photo-view preview, Deep rounds/usage/stopReason/partial, safe ProblemNotice            |
| `S8-T07` | Full command matrix, OpenAPI/runtime/capability/operation checks and evidence hashes                                                       |

Key test IDs exercised:

`TEST-MULTI-001-BLOCK`, `TEST-TRAIN-001-BLOCK`, `TEST-TRAIN-003-BLOCK`,
`TEST-X-IMAGE-CAPTION`, `TEST-SEARCH-006-BLOCK`, `TEST-SEARCH-008-BLOCK`,
`TEST-PARSE-005-BLOCK`, `TEST-AUTH-003-BLOCK`, `TEST-X-DEEP-BUDGET`,
`TEST-X-FRONTEND-A11Y`, `ACC-UI-01...07`.

## UI Evidence

| Viewport    | PNG                  |     Size | SHA-256                                                            |
| ----------- | -------------------- | -------: | ------------------------------------------------------------------ |
| Images 360  | `s8-images-360.png`  | 63,266 B | `104af941fe011a21eebe5319bec8bd94df7566eb8928e09fc67a1e86aad19514` |
| Images 768  | `s8-images-768.png`  | 59,560 B | `cbadd25d69f33b0654622c87d2a8b24fc55ad878d2f754d73a7b03ab0218d27d` |
| Images 1200 | `s8-images-1200.png` | 63,545 B | `63b4ab2baa274683afab48cc96ca2f78e2c88a30593c113ec5cb5787657489c0` |
| Deep 360    | `s8-deep-360.png`    | 63,770 B | `3a13448620e1e9eeb0eb0ab8fca302a037c8afd1437db3a3c4a66db9f2edfed1` |
| Deep 768    | `s8-deep-768.png`    | 65,975 B | `38e7d70366e0507eed86628071e0fa7cc445dc9b2f5bfa62eb8cd5e96e3e75a8` |
| Deep 1200   | `s8-deep-1200.png`   | 68,648 B | `e875e848741255d929261e21881dc54f7fab10fca3280dae1dfeb5fb7df63bce` |

Each viewport passed axe serious/critical `0`, horizontal overflow `<= 0`,
console errors `0`, page errors `0` and failed runtime requests `0`.

## Generated Artifact Hashes

| Artifact                      | SHA-256                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `pnpm-lock.yaml`              | `a12d7b5430abfb013b6af52dbabc6d6a30c0b96b4f6f48d1a4d0454b3a691e7f` |
| `openapi.json`                | `acf90409c5cba841e5672acb2c5b9ea3891879d61f56d7c6335d66660cd2b456` |
| `runtime-registry.data.json`  | `9308cebbfe79500c7a4c79332871419a82340920ef41999e7550ef1619ee09bc` |
| `deferred-manifest.data.json` | `aeef9a15cecfefca6d19bd10fca59192ecdbba5bc1a74cd89ac9d2ff576f07af` |
| `artifacts/sbom.json`         | `f00a160619063fd3b1afe215d8cd5968b487ca4e1ac514b90979e00348927065` |
| `NOTICE`                      | `f84b717ac3281cf18f0d616ab2547d9afc62f4448f345f66720039e24a9ca4f2` |

## Shared Files And Boundaries

- Shared runtime assembly remains centralized in `knowledge-runtime.ts`.
- No second search, model or image pipeline was introduced.
- No image collection or vector table was added.
- Caption text is not reported as an image vector.
- S6 queue, fencing and retry semantics remain intact; the fixed
  `s8_caption_executor_missing` branch is removed.
- Frontend receives `messageKey + params`; object keys, buckets and raw provider
  errors are not rendered.
- S9 has no page, navigation, i18n, query key, handler or runtime registration.

## Provider State

- `REAL_VERIFIED`: local Mongo replica set, Redis, PostgreSQL/pgvector, MinIO,
  canonical HTTP app, ticket route and Chromium.
- `FIXTURE_VERIFIED`: VLM caption, vision embedding order, Deep planner and stop
  behavior, provider faults.
- `EXTERNAL_UNVERIFIED`: production AIProxy VLM/embedding/rerank credentials,
  vendor vision capability and IAM/API-key scope.

See `docs/acceptance/s8-provider-matrix.md`.

## Risks And Open Gates

- Production Provider credentials and real vendor capability remain external.
- The local Mongo CI URI needs `directConnection=true` because of the local
  replica-set advertised hostname.
- User install timestamp and exit code were not recorded; the installed state
  itself is verified.
- The repository reports five pre-existing release-legal blockers. They do not
  block this branch gate and require S11/legal disposition.
- W3 is not complete: PersonA candidate SHA, S9 rebase, same-SHA personA/personB
  gates and runtime `110/10`, capability `53/49` are still outstanding.
