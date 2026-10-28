# S8 Image And Deep RAG Stage Evidence

## Status

- Status: `S8_REVIEW_FIX_LOCAL_PASS_PENDING_CI`.
- Wave / stage / owner: `W3 / S8 / personB`.
- Base SHA: `13fa0e9be84edd33ea5cc5413d64282c126dd117`.
- Implementation candidate SHA: `9ed48366872bfa35271a4d3ce77f1ef84de06eec`.
- Review remediation candidate SHA: `4e4a0be8aba3b716a984ca41f1c25fb4f04f1701`.
- Branch: `feat/kb-s08-image-deep-rag`.
- Worktree: `/home/archer/RAG-agent-platform-w3-s8-personB`.
- PR: `#32` (`feat/kb-s08-image-deep-rag` to `main`).
- Remote state: PR #32 previously contained `03e2362`; the review remediation
  commits are local and were not pushed by the Coding Agent.
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
| `pnpm typecheck --force`                              |    0 | `12/12` packages                                            | `18c7119e944205ea0c79d450a5c13def66d9f70ff68a4c42a18b2f2dc5c2a8ae` |
| `pnpm architecture:check`                             |    0 | `123` service files, `12` packages                          | `9813d1dbc44482ec1676d0d94d1fb31c01fbbe91da60a94bc5bbeed5bfca5273` |
| `pnpm forbidden-files:check`                          |    0 | `508` files, no forbidden source                            | `818832b8d110aef664a5be108116eddb01a54038caa39438fb229a8e08b928f3` |
| `pnpm test:unit --force`                              |    0 | `22/22` tasks                                               | `e46fe1ee176e31cd548b53b9a85acc19bd2f6a9b0136674b2e94a137c8d1ff66` |
| `pnpm test:contract`                                  |    0 | `19` files, `93` tests                                      | `8de2ff798b4c5c0125cfa2494421880fa004aeb3ab0779e2abf16b32c7ecb273` |
| `pnpm test:integration --force`                       |    0 | `28` files, `155` tests                                     | `11d8549404da35dc89650ad991002b4c7dddae7d2a563f3e75d8cc94fd96e7aa` |
| `pnpm test:tenant`                                    |    0 | `7` files, `16` tests                                       | `0976e33c60ac791387f13c7394528c40ff282562de9d463b5f6dd3dc46c4b981` |
| `pnpm test:concurrency`                               |    0 | `7` files, `14` tests                                       | `e53199c1f767e953cfb553f6a6719b66fb4b809f4ea4d9319a9e323c1955d40f` |
| `pnpm test:fault`                                     |    0 | `9` files, `33` tests                                       | `69ce511a51c0498a042010cb6b5d68d41e1d49313a34bad48ef4f5cc3eaf3da0` |
| `pnpm test:e2e`                                       |    0 | `11` files, `54` tests                                      | `2d37560454d8ad9e1b5a8e9c22f49850b71f9e96a79259d4f0208731c5572859` |
| `pnpm build --force`                                  |    0 | `12/12` packages; Images/Search routes built                | `2e18c2380015c81450a7073bc4d94813dfe7b22b66bdd7c555aa6528ad1b5374` |
| `pnpm build:workers --force`                          |    0 | worker bundle built; `knowledge-caption` remains registered | `8e6d9296de7a7ff93fe20598e2cd6737bd013165ba6de40c2b78ac08d7524b2e` |
| `docker compose ... config --quiet`                   |    0 | default profile valid                                       | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docker compose --profile aiproxy ... config --quiet` |    0 | AIProxy profile valid                                       | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| Compose `up -d --wait --pull never`                   |    0 | Mongo, Redis, pgvector, MinIO healthy                       | `485f4833c697b3d86c67e72e580dd3e915432677078f19eaf64ebfa2aaf8802b` |
| `pnpm sbom:generate`                                  |    0 | `160` direct, `1639` transitive, `12` workspaces            | `bbf252e81cafe277fa9156dd32e4179988eadc3e8bd36fa382ef1d44505c22f4` |
| `pnpm license:check`                                  |    0 | `160` catalog, `950` production components                  | `0d4d67e1a0cae29e5ec2bdd82e0eba7bb36dff15e13e75619711e2a9ee314623` |

The first integration attempt used the CI URI without `directConnection=true`
and failed during Mongo topology discovery before tests ran. The same command
then passed with the local direct-connection adjustment; no test was skipped or
weakened.

## Review Remediation

| Finding    | Resolution                                                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `S8-RV-01` | Every Deep query now recomputes the remaining total/round budget and does not call retrieval when exhausted; actual gateway/search usage is propagated                      |
| `S8-RV-02` | Every requested Space is authorized before model resolution or planner invocation                                                                                           |
| `S8-RV-03` | Preview tickets carry signed member/owner/scopes and content rechecks Source ACL; cached previews are refreshed after expiry                                                |
| `S8-RV-04` | Image Segment source-version switch atomically clears old indexes/fullText/status before new CAS publication                                                                |
| `S8-RV-05` | S5 writes deterministic zero-quantity intent before each provider call and actual usage after; S8 supplies safe audit metadata                                              |
| `S8-RV-06` | Caption and vision embedding resolve independently; one missing path is partial, both missing is 422; document image orchestration preserves partial evidence               |
| `S8-RV-07` | Image caption/vector recall uses the complete S7 compiled Source filter and rechecks the allowed Source set after hydration                                                 |
| `S8-RV-08` | Images/Deep acceptance now runs against real Next routes; ticket revocation is exercised; fixture screenshots no longer write acceptance files; old S3/S5 PNGs are restored |
| `S8-RV-09` | This evidence and the stage report use the review-fix candidate, actual PR/local state, final gate counts and hashes                                                        |

The real-page suite covers `54` E2E tests and includes
`test/e2e/s8-image-deep-page.test.ts`, with real Mongo/Postgres/MinIO object
content, browser requests, ticket revocation, axe and overflow checks.

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

| Viewport    | PNG                  |      Size | SHA-256                                                            |
| ----------- | -------------------- | --------: | ------------------------------------------------------------------ |
| Images 360  | `s8-images-360.png`  |  74,470 B | `f319b805c17234b42c67f493a7d465485bb8deabc1637425798116902ed40319` |
| Images 768  | `s8-images-768.png`  |  83,359 B | `cc582b3c3042be3b3ee4830f939cf1c50b986084d884884546185aa61474a410` |
| Images 1200 | `s8-images-1200.png` |  94,662 B | `bc5fc8e04b12116bd6107eb7eeda8b148fef80f7ebf6ed243c6919e95ec97447` |
| Deep 360    | `s8-deep-360.png`    |  98,842 B | `7880c7bf7854d9e02040094a232be65bd90ed328c77cec55773e760fde64383a` |
| Deep 768    | `s8-deep-768.png`    | 105,917 B | `d1863ce66d2fabacf61ac2be8fd43e2bf90f2cf01dcb5447d70aaace2a28e3d3` |
| Deep 1200   | `s8-deep-1200.png`   | 118,395 B | `89f712e3cc918a9a893fec15126ee606a508fda28bdd3747ef704c643d3814e3` |

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
- The review-fix commit is local; PR #32 CI must run again after the user pushes
  the new commit.
