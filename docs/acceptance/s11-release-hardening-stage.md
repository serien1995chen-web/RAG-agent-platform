# S11 Release Hardening Stage Evidence

## Status

- Result: `SCOPED_BLOCKED`.
- Wave / stage / owner: `W4 / S11 / personA`.
- Branch: `feat/kb-s11-release-hardening`.
- W4 base: `14a3b9e96fcab7b6a1f1e92ccdf4dc775719ee7d`.
- S10 merge: `d7e38c71293a283cd6268605b5036e8ee5763c9a`.
- S10 ancestor check: exit `0`.
- Candidate SHA: not frozen.
- Evidence commit SHA: not created.
- Worktree: `/home/serien/RAG-agent-platform-s11`. Implementation checkpoint:
  `4fcbceb`; it is not a frozen candidate or evidence worktree.

This report records a blocked phase1/post-rebase checkpoint. It is not a
whole-stage PASS and does not close W4.

## Inputs

| Input                       | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| S11 implementation plan     | `D9F199F1BACE424D55A3BBFEDFEEB2DA6507F45EA11AA9512C1C118B56CEEA47` |
| KnowledgeBase system design | `8E5E7300C651C4FE0478B87FC3572ADD52F95C3E49C8F15700B45BB8C690A26D` |
| Stage task breakdown        | `11AA3693599759EF969C9F6AD85AE61DA8FD925940BAACFB17A1C5C389E2FB6E` |
| Coding rules                | `6160D409FA57EA0DE6BEF24777979492F0ED10520070032AC5DF578211EF8CC9` |

## Opening And Rebase Checks

```text
S10 parent set: 14a3b9e9... + a80dc23e...
origin/main: d7e38c71...
merge-base --is-ancestor d7e38c71... HEAD: exit 0
contract: 92 paths / 120 operations / 139 schemas / 8 parameters
runtime/deferred: 120 / 0
capabilities: 73 total / 12 BASE / 57 DATA / 4 EXCLUDED
mongoCollections: 23
vectorProfiles: 4
queues: 13
```

The ten S10 operations are present. `DOWN-001...004` remain governed by S10
real API-key evidence and are not closed by this blocked report. W3 remains
53 implemented / 49 closed.

## Task Coverage

| Task      | Current result                             | Implemented surface                                                                                              | Evidence                                                                                  |
| --------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `S11-T01` | BLOCKED for real chain                     | deterministic fixtures, full-chain stack/API-key harness and runbook                                             | fixture manifest stable; phase1 harness tests pass                                        |
| `S11-T02` | `SCOPED_BLOCKED`                           | AIProxy/OCR/Feishu HTTP adapters, mode-aware connector factory, scoped deferred guards and real-provider harness | provider matrix sha `1dde3fbc...`; 18 missing scoped fields                               |
| `S11-T03` | fixture PASS; full runner `SCOPED_BLOCKED` | k6 probe/full runner, three scenarios, canonical PDF upload fixture, 1M Segment seeder and strict validation     | k6 v2.3.0 probe READY; 1,000,000 actual Segments; 300 unique uploads; real models missing |
| `S11-T04` | local PASS; external key scope blocked     | SSRF, archive, MIME, Range, XSS, tenant and secret tests                                                         | 10 files / 21 tests                                                                       |
| `S11-T05` | generate + consume real drill PASS         | container recovery executor, media generator/consumer, isolated restore, counts/hash and health guards           | differences 0; health/ready 200; 2 files / 9 tests                                        |
| `S11-T06` | local matrix PASS; final candidate blocked | real Playwright 18-page matrix, axe, overflow, keyboard, network and external evidence                           | 18 x 3 = 54 screenshots; UI summary `4686ca2b...`                                         |
| `S11-T07` | static PASS; production deferred           | approved obligations, generated NOTICE/SBOM, five third-party digests and release semantics                      | release check `DEFERRED_TO_PRODUCTION`; app digest pending                                |
| `S11-T08` | blocked template/report                    | 73-row generator, collector, validator and Scoped matrix logic                                                   | 73 unique rows; no candidate-bound PASS                                                   |

## Local Gate Results

| Gate                                     | Exit | Key result                                                       |
| ---------------------------------------- | ---: | ---------------------------------------------------------------- |
| `pnpm lint`                              |    0 | PASS                                                             |
| `pnpm format:check`                      |    0 | PASS                                                             |
| `pnpm typecheck`                         |    0 | 12/12 tasks                                                      |
| `pnpm architecture:check`                |    0 | 152 service files / 12 workspace packages                        |
| `pnpm forbidden-files:check`             |    0 | 651 files / 0 forbidden references                               |
| `pnpm license:check`                     |    0 | approved-2026-10-29; 5 obligations                               |
| `pnpm sbom:generate`                     |    0 | 166 direct / 1654 transitive / 12 workspace / 6 image components |
| `pnpm openapi:check`                     |    0 | `92/120/139/8`; runtime `120/0`                                  |
| `pnpm knowledge:inventory`               |    0 | `73 = 12 + 57 + 4`; Mongo 23; profiles 4; queues 13              |
| `pnpm knowledge:check-runtime`           |    0 | runtime 120; deferred 0; old page route 0                        |
| `pnpm build`                             |    0 | 12/12 tasks; 20 application routes                               |
| `pnpm build:workers`                     |    0 | 11/11 tasks                                                      |
| `pnpm test:unit`                         |    0 | 22/22 tasks                                                      |
| `pnpm test:contract`                     |    0 | 25 files / 130 tests                                             |
| `pnpm test:integration`                  |    0 | 33 files / 179 tests in the service integration slice            |
| `pnpm test:tenant`                       |    0 | 10 files / 19 tests                                              |
| `pnpm test:concurrency`                  |    0 | 10 files / 22 tests                                              |
| `pnpm test:fault`                        |    0 | 14 files / 47 tests with explicit `KB_TEST_*`                    |
| `pnpm test:security`                     |    0 | 10 files / 21 tests                                              |
| `pnpm test:e2e`                          |    0 | 18 files / 73 tests                                              |
| Playwright S11 matrix                    |    0 | 18 pages x 3 viewports; 54 screenshots                           |
| `pnpm test:provider:real`                |    2 | `SCOPED_BLOCKED` by 18 missing input names                       |
| provider matrix generator                |    0 | 8 rows; 5 unverified / 3 deferred; 0 real                        |
| `pnpm test:performance` probe            |    0 | `PERFORMANCE_READY`                                              |
| performance full fixture                 |    0 | 1M actual Segments; 300 unique uploads; `s11-perf-v1`            |
| performance full runner                  |    4 | `PERFORMANCE_PROVIDER_BLOCKED`; real model inputs missing        |
| `pnpm test:recovery -- --check`          |    0 | `RECOVERY_CHECK_READY`                                           |
| recovery local tests                     |    0 | 2 files / 9 tests                                                |
| `pnpm release:check --allow-missing-app` |    0 | `DEFERRED_TO_PRODUCTION`; no release PASS                        |

## Provider Status

| Provider             | Real status           | Current reason                                                    |
| -------------------- | --------------------- | ----------------------------------------------------------------- |
| TokenDance / AIProxy | `EXTERNAL_UNVERIFIED` | scoped env, approved catalog mapping and model profile are absent |
| Somark               | `EXTERNAL_UNVERIFIED` | `S11_OCR_SOMARK_PROFILE_JSON` absent                              |
| TextIn               | `EXTERNAL_UNVERIFIED` | `S11_OCR_TEXTIN_PROFILE_JSON` absent                              |
| Doc2X                | `EXTERNAL_UNVERIFIED` | `S11_OCR_DOC2X_PROFILE_JSON` absent                               |
| Feishu               | `EXTERNAL_UNVERIFIED` | app credentials, Drive folder token and two docx IDs absent       |
| Sangfor              | `DEFERRED_BY_SCOPE`   | no real call permitted                                            |
| Yuque                | `DEFERRED_BY_SCOPE`   | real mode returns explicit deferred guard                         |
| DingTalk             | `DEFERRED_BY_SCOPE`   | real mode returns explicit deferred guard                         |

No mock transport is represented as a real Provider success.
The generated matrix is `docs/acceptance/s11-provider-matrix.md` with SHA-256
`1dde3fbc9a62d8f2713768d0913d819bc5e05bc9a77ba0dc7d45cf597f1e62df`.

## Performance, Recovery And UI

- k6 v2.3.0 is available and the local app `/readyz` returned `200`.
- Full performance fixture is complete: `segmentCountActual=1000000`,
  `seedVerified=true`, `uploadIdCount=300`, fixture hash
  `82b20e68f2eb52d5f0dc2c3b604be348adf1f3cff448fec281a9bb4e9f971cee`.
  The k6 full runner remains blocked on missing real AIProxy models.
- All required recovery tools exist inside the Mongo, pgvector, MinIO and Redis
  images. A real generate and consume drill completed against isolated
  Mongo/PostgreSQL/Redis/MinIO targets with zero count differences,
  health/ready 200, 23 Mongo collections, 4 vector profiles, 18/18 Redis keys,
  3/3 MinIO objects and no duplicate events. Generate summary
  `cca7560c25f61feef91c4c64ac7bc89bd7f5b3066107040e85568a233315bdc6`;
  consume summary
  `87c5bad91ac57ebdbba4e1e2882cc610e64bfec645ddbc0ccecdc90c43d89b28`.
- The real browser matrix produced 54 PNG files, 54 SHA-256 sidecars and
  `ui-summary.json` SHA-256
  `4686ca2bc645b609a66e1a03e55e5d1c443c5e0878f82f1370838005360ad31d`.
- UI evidence is outside the worktree. The matrix found 0 serious/critical axe
  issues, 0 overflow and 0 runtime request failures.

## License And Release

The five approved exceptions are
`argparse@2.0.1`, `caniuse-lite@1.0.30001814`,
`jschardet@3.1.1`, `pako@1.0.11` and `sax@1.6.1`.
Approval source is the user-transmitted legal approval dated 2026-10-29. No
signature or approver identity is fabricated.

| Artifact                                  | SHA-256                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `NOTICE`                                  | `b5a4dbcf5b25377d5467eef3189e8b59c784d142ed89b92c4614ecc03ebc551e` |
| `artifacts/sbom.json`                     | `88ed3b23a416e7295c8a76ec0abe280b2de5a015fad200c35e70cae4e92a5c89` |
| `deploy/release-images.data.json`         | `aa77525cdcc985cf6e9ab9ab6140b38c9bb65f720f065f2bbe21a31fd6f3c0aa` |
| `scripts/license-obligations.data.json`   | `09ff0d671766a7bc65fff30bc673934fd7533535b53409bc4cc8aeb2f785dd75` |
| `test/fixtures/s11/fixture-manifest.json` | `44998778494b8abdd3da9eb93e86c36b143e209d8b82224f60643c573435ec51` |

Five third-party runtime images retain tag plus digest. The application image is
`PENDING_RELEASE_EVIDENCE` and production Registry/SaaS staging remain deferred.

## C7, Pricing And Quota

- C7 remains `SCOPED_BLOCKED`: real AIProxy/OCR/Feishu, real S10 API key,
  worker and Source-to-Citation-to-Delete evidence are absent.
- `zero-v1` remains the default pricing profile.
- `fixture-v1` usage facts and micro-point recomputation are covered locally,
  but no real Provider usage claim is made.
- `free-v1` remains the default quota. `s11-perf-v1` remains a test-only
  fixture and is not exposed by API or UI.

## Capability Report

`docs/acceptance/s11-release-report.md` contains 73 unique capability/test
rows. No row is promoted to PASS from this blocked stage report. The report is
regenerated from the scoped template with explicit real-provider,
full-performance, release and candidate blockers.

## Remaining Actions

1. Inject scoped Provider values outside the repository and approve the five
   catalog model mappings.
2. Provide a real Drive folder token containing two readable docx files.
3. Inject real AIProxy models, restart in real mode and run the three k6
   scenarios against the verified fixture.
4. Re-run Provider, performance, UI, recovery and release gates after all
   external inputs are complete.
5. Only after all scoped gates pass, freeze `candidateSha`, write
   `s11-personA-gate.md`, and request independent personB evidence.

PersonB evidence, Scoped wave evidence, final CI binding and W4 completion have
not occurred.
