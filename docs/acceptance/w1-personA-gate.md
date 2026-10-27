# W1 PersonA Gate

## Status

- Result: `PASS` for the personA side.
- Wave / stage / owner: W1 / S5 / personA.
- Parallel stage: S4 / personB.
- Branch: `feat/kb-s05-model-parse`.
- W1 baseline: `4cf765b2d82496f74e92eb27327a2358c92fe928`.
- S4 personB merge SHA: `506ed2c07edcd02219d1824a5271e283a6022c2b`.
- Candidate SHA: `d20da2511b185f9274bd7520d4fb935d68593f44`.
- PersonB gate: `PASS` on the same candidate.
- PersonB evidence SHA-256:
  `66728066509ecc3a7a91ef7908e1f4d6f78c5825f046da41b27407beb622e841`.
- Evidence commit SHA: `SELF_DOCS_ONLY_COMMIT` (exact SHA recorded in the final
  delivery report).
- Wave W1: `PASS_PENDING_FINAL_CI_AND_REVIEW_BINDING`.
- Worktree: `/home/serien/RAG-agent-platform`.
- Worktree state at gate start: clean, zero porcelain entries.
- S4 ancestry: `git merge-base --is-ancestor 506ed2c07edcd02219d1824a5271e283a6022c2b HEAD` exited `0`.

This is independent personA evidence. PersonB returned an independent PASS for
the same candidate. W1 still requires CI at the final docs-only evidence commit
and the Review/PR Review binding.

## Environment

- OS/runtime: WSL2 Ubuntu 22.04.5 LTS.
- Node.js: `v22.23.2`.
- pnpm: `10.33.4`.
- Docker: `29.6.2`, build `dfc4efb`.
- Mongo: `mongodb://127.0.0.1:27017/kb_w1_persona` with
  `replicaSet=rs0&directConnection=true`.
- Redis: `redis://127.0.0.1:6379/0`.
- PostgreSQL: `postgresql://kb:kb_dev_password@127.0.0.1:5432/kb`.
- MinIO/S3: `http://127.0.0.1:9000`, bucket `kb-local`.
- AIProxy: fixed `v0.7.3` digest on `http://127.0.0.1:3001`.
- AIProxy PostgreSQL: fixed `pgvector:0.8.0-pg15` digest.
- External model, VLM, STT, TTS, and OCR credentials: not supplied.

## Commands

All commands ran from the candidate worktree.

| Command                                               | Exit | Key result                                          | Log SHA-256                                                        |
| ----------------------------------------------------- | ---: | --------------------------------------------------- | ------------------------------------------------------------------ |
| `git status --porcelain`                              |    0 | zero entries at start                               | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `pnpm lint`                                           |    0 | PASS                                                | `44a324755a0f8558e6dfa740802cbf0c5764fd89ec64d2136f1ced111481ce5a` |
| `pnpm format:check`                                   |    0 | PASS                                                | `8903dade39c192573add1286b2da34e1ec38823f4981527a5b7edb99b2f2844c` |
| `pnpm typecheck`                                      |    0 | 12/12 tasks                                         | `c69878bbc1b2e8d7dc28d135252f9b7daf0ec744aaa512d049cf61c688694cee` |
| `pnpm architecture:check`                             |    0 | PASS                                                | `be0acfb9bf6e49b13376e689b8050209a14c7f2863ec0d278e831aad6d9ae38a` |
| `pnpm forbidden-files:check`                          |    0 | PASS                                                | `6ca099253e73f854c07c0d014fd6542c26901a0f8d5fa713c74d6d27905d2fbb` |
| `pnpm openapi:check`                                  |    0 | `92/120/139/8`, `83/37`                             | `48d8298124986e9636983628b054fdbf9bd80e984cf9a4f384c08ace1ea2da66` |
| `pnpm knowledge:inventory`                            |    0 | runtime `83`, deferred `37`                         | `3e0bfeca40351b6dfbd435739489e0280ff785ec9938548cadd45a886940b634` |
| `pnpm knowledge:check-runtime`                        |    0 | intersection `0`, union `120`                       | `a5f45b1a34e58d41238811bc14fc45a790c8cf11a9f53a66fd2447403f5f78c4` |
| `pnpm test:unit`                                      |    0 | Turbo `21/21` tasks                                 | `79d6ddc1751fda11ee6605722140d2ec49253f3f4dd81d7ed817ff2d11acac0e` |
| `pnpm test:contract`                                  |    0 | `75/75` tests                                       | `befaf011734c42443a29da16d2c6cc1323f1ee31d42d284ac29245609fa32283` |
| `pnpm build`                                          |    0 | 12/12 tasks                                         | `a787773dbe69541bb1349129d65229a01bc3dd8c816d8076d967b8e640e711e5` |
| `pnpm build:workers`                                  |    0 | 10/10 tasks                                         | `049687cfd231c0a98c9ed335ae4243be181137d8ec6fa3c14f69c8a9f287fe64` |
| `pnpm test:integration`                               |    0 | Turbo `21/21`; service `97/97`                      | `4c97a686248a0ce10cfc4cbb9ef0512d7e82107d6a5166e04861f525a4fe7205` |
| `pnpm test:tenant`                                    |    0 | `11/11` tests                                       | `08b7f67071575e0127fc403d7ee1065f4ae9c8f459484fde530464619b1b7a71` |
| `pnpm test:concurrency`                               |    0 | `12/12` tests                                       | `5d9e2ac1fee75fc3a06e27a5f2c479ef443789069e51903b1bdee8f6fe0359bd` |
| `pnpm test:fault`                                     |    0 | `24/24` tests                                       | `a6d2698dbf8f92425cba051c048958d24687a87a59d7e752d60110ea211f898e` |
| `pnpm test:e2e`                                       |    0 | `34/34` tests in five files                         | `855c1478aa55d23d944ad8fef0ed4018e267b79a2719f33bc701dfa7178272f4` |
| `pnpm license:check`                                  |    0 | 132 catalog entries, 684 production components      | `67b471a1a93766c06937ba65c2d0ad94a9a4cff730d7cf3538d47ebca1952451` |
| `pnpm sbom:generate`                                  |    0 | 132 direct, 1398 transitive, 12 workspace, 4 images | `f167b00110e43dd4d69db520e2b175a811292402201bcecf41364f32ddbdb89f` |
| `docker compose ... config --quiet`                   |    0 | base profile valid                                  | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docker compose --profile aiproxy ... config --quiet` |    0 | AIProxy profile valid                               | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docker compose ... up -d --pull never ...`           |    0 | fixed local images only                             | `5d0283e3d5ac137adcb3ed84dbf562db7e79e622988184780899385afd4601a9` |
| `docker compose ... ps ...`                           |    0 | AIProxy and PostgreSQL healthy                      | `cd2e61ec91a4ce2d52c06f7f054f5db01938cd7846c2031d04834ae1959745d3` |
| `curl -fsS http://127.0.0.1:3001/api/status`          |    0 | HTTP 200, success                                   | `7e9458ed091c4b96425104c7664dbdcac582a1c5258606d7b495fd0f20766a70` |
| AIProxy local token + `GET /v1/models`                |    0 | HTTP 200, empty catalog                             | `a61bd022e84c9309ac240ecc6eb30ddddadf6fd4e25bb6259c125fa8e161a4b7` |
| `pnpm openapi:generate`                               |    0 | `92/120/139/8`, `83/37`                             | `1b75ae808a5aa7e32404f9893ac2ccaa3b897736a52a4821b2b1797d6277e6f2` |
| `pnpm openapi:check` after generation                 |    0 | PASS                                                | `48d8298124986e9636983628b054fdbf9bd80e984cf9a4f384c08ace1ea2da66` |
| `git diff --check`                                    |    0 | PASS                                                | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

## Contract And Runtime

- Contract counts: `92 paths / 120 operations / 139 schemas / 8 parameters`.
- Runtime/deferred: `83/37`.
- Runtime intersection: `0`; runtime union: `120`.
- Old page routes: `0`.
- S4 runtime operations retained: 14.
- S5 runtime operations appended: 4.
- S5 operations: `API-MODEL-LIST`, `API-MODEL-BINDING-GET`,
  `API-MODEL-BINDING-UPDATE`, `API-MODEL-BINDING-VALIDATE`.
- `pnpm openapi:generate` regenerated only the five approved contract artifacts.
- No `parseVersion`, public settings field expansion, Deferred S5 operation,
  legacy Dataset route, or S6 worker/child Job was introduced.

## Test IDs

| Test ID                    | Result | Evidence                                                                        |
| -------------------------- | ------ | ------------------------------------------------------------------------------- |
| `TEST-X-COMPOSE-READY`     | PASS   | Compose config, fixed digests, healthy services, status and empty model catalog |
| `TEST-MODEL-001-BLOCK`     | PASS   | Catalog, validation, UI and E2E                                                 |
| `TEST-MODEL-002-BLOCK`     | PASS   | Gateway request and response contract                                           |
| `TEST-MODEL-003-BLOCK`     | PASS   | Retry, fallback and usage/outbox facts                                          |
| `TEST-MODEL-004-BLOCK`     | PASS   | QA schema, repair, dedup and fallback                                           |
| `TEST-MODEL-005-BLOCK`     | PASS   | Six model types and four embedding dimensions                                   |
| `TEST-MODEL-006-BLOCK`     | PASS   | Auth, timeout and provider failure behavior                                     |
| `TEST-KB-002-BLOCK`        | PASS   | Binding GET/UPDATE, CAS, tenant and conflict                                    |
| `TEST-PARSE-001-BLOCK`     | PASS   | Ten-format matrix, LiteParse 2.0.8 and PDF.js load fallback                     |
| `TEST-PARSE-002-BLOCK`     | PASS   | Four OCR provider contracts and timeout fallback                                |
| `TEST-PARSE-003-BLOCK`     | PASS   | Deterministic chunk settings and policy mapping                                 |
| `TEST-PARSE-004-BLOCK`     | PASS   | QA validation, one repair, dedup and fallback                                   |
| `TEST-X-OCR-TIMEOUT`       | PASS   | Primary timeout and bounded fallback                                            |
| `TEST-X-PROVIDER-CONTRACT` | PASS   | Provider request and response matrix                                            |
| `TEST-X-SECRET-LEAK`       | PASS   | Credential/Prompt redaction and scan                                            |
| `TEST-X-FRONTEND-IMPORT`   | PASS   | S4 Import plus S5 parser/chunk/QA settings                                      |
| `ACC-UI-01...07`           | PASS   | `360/768/1200`, overflow and blocking axe checks                                |

## Capability

- `KB-002`: personA gate `PASS`.
- `MODEL-001` through `MODEL-006`: personA gate `PASS`.
- `PARSE-001` through `PARSE-004`: personA gate `PASS`.
- C2: parse/chunk/QA output retained for S6; no Segment, Job, search, or index
  write from S5 processing.
- C6: model and OCR attempts produce idempotent usage facts and pending
  `knowledge-outbox` events without quota/admin implementation.

Capability status here is limited to candidate code and personA execution. It
does not replace the independent personB gate or final Review closure.

## Real / Mock / External

### Real verified

- AIProxy Compose containers and independent PostgreSQL reached healthy state.
- AIProxy `/api/status` returned HTTP 200.
- AIProxy `/v1/models` returned HTTP 200 with `{"data":[],"object":"list"}`.
- LiteParse 2.0.8 package loading and local PDF.js load-error fallback.
- Local Mongo replica set transactions, Redis, PostgreSQL and MinIO.

The empty AIProxy model catalog proves gateway routing only. It does not prove
an upstream model is available or usable.

### Mock pass

- AIProxy catalog and model HTTP fake contracts.
- Four OCR provider HTTP fake contracts.
- QA generation, local repair, dedup and fallback fixtures.
- Retry, auth, timeout, tenant and concurrency fault injection.

### External unverified

- Real LLM, embedding, rerank, VLM, STT and TTS provider calls.
- External Sangfor, Somark, Textin and Doc2x credentials.
- Durable provider-side billing and quota behavior outside S5 usage facts.

## Risks And Pending Work

- CI URL and Review/PR Review binding are not yet produced. CI must run at the
  final docs-only evidence commit.
- External providers remain `EXTERNAL_UNVERIFIED`; no result is relabeled as
  `REAL_VERIFIED`.
- The license gate passes but reports five pre-existing
  `pending-legal-review` release blockers: `argparse`, `caniuse-lite`,
  `jschardet`, `pako`, and `sax`.
- `DOWN-004` remains `DATA`; S10 remains responsible for real API key closure.
- S11 is unrelated and was not implemented or modified.
