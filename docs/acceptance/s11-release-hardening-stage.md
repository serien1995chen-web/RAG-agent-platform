# S11 Release Hardening Stage Evidence

## Status

- Result: `BLOCKED`.
- Wave / stage / owner: `W4 / S11 / personA`.
- Phase: `phase1 + post-rebase pre-install`; no candidate freeze and no whole-stage PASS.
- Branch: `feat/kb-s11-release-hardening`.
- W4 base: `14a3b9e96fcab7b6a1f1e92ccdf4dc775719ee7d`.
- Opening HEAD / status: exact base / empty porcelain.
- Post-rebase state: S11 branch rebased onto `d7e38c7...`; current HEAD is
  recorded in the handoff, not self-referenced here.
- S10 merge SHA: `d7e38c71293a283cd6268605b5036e8ee5763c9a`; ancestor check
  passed.
- Post-rebase runtime / deferred: `120 / 0`; contract remains `92/120/139/8`.
- S11 worktree installation: `PASS`; user ran `pnpm install` in
  `/home/serien/RAG-agent-platform-s11` with exit 0. The lockfile remained
  `b6478a45...` with no tracked diff.
- Candidate SHA: not frozen.

## Inputs And Opening Checks

| Input                       | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| S11 implementation plan     | `44B088041C11F17B1B58FA14DF578D6D39C63D12D2A4827071570D43F7CC2D15` |
| KnowledgeBase system design | `8E5E7300C651C4FE0478B87FC3572ADD52F95C3E49C8F15700B45BB8C690A26D` |
| Stage task breakdown        | `11AA3693599759EF969C9F6AD85AE61DA8FD925940BAACFB17A1C5C389E2FB6E` |
| Coding rules                | `6160D409FA57EA0DE6BEF24777979492F0ED10520070032AC5DF578211EF8CC9` |

The Plan has 8 Tasks with exactly 12 fields, 65 steps with 9 fields, and
phase1/real-provider/post-rebase/candidate groups for every Task.

Opening inventory:

```text
capabilities: 73 total / 12 BASE / 57 DATA / 4 EXCLUDED
contract: 92 paths / 120 operations / 139 schemas / 8 parameters
runtime: 110 / deferred: 10
mongoCollections: 23 / vectorProfiles: 4 / queues: 13
```

The ten S10 deferred operations and all four `DOWN-001...004` DATA entries
remain unchanged. W3 evidence remains `53 implemented / 49 closed`.

## Task Coverage

| Task      | Phase1 result                       | Implemented surface                                                               | Evidence                                                                                        |
| --------- | ----------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `S11-T01` | BLOCKED, setup PASS                 | deterministic fixture generator, full-chain fixture/harness and runbook           | fixtureHash `eb11355abb5af04128bb365de37494898aec250ef0d48d2bc9f5467768101856`; 3 harness tests |
| `S11-T02` | BLOCKED, contract PASS              | Feishu/Yuque/DingTalk HTTP delegates, shared transport, provider input preflight  | 11 provider contract tests                                                                      |
| `S11-T03` | BLOCKED                             | k6 search/deep/import scripts, runner and fixture preparer                        | `PERFORMANCE_K6_UNAVAILABLE`, exit code 127                                                     |
| `S11-T04` | local PASS; S10 key items BLOCKED   | SSRF, archive, range/XSS, tenant and secret tests                                 | 12 security tests                                                                               |
| `S11-T05` | local PASS; real recovery BLOCKED   | prefix-safe recovery commands, fault matrix and invariants                        | 7 recovery tests; `RECOVERY_TOOL_UNAVAILABLE`                                                   |
| `S11-T06` | registry PASS; final UI BLOCKED     | 18-page registry, 3 viewports, a11y helpers and external screenshot switch        | all 18 pages enumerated; 54 screenshots not run because app build is blocked                    |
| `S11-T07` | static PASS; release BLOCKED        | approved obligations, generated NOTICE/SBOM, release manifest and Compose overlay | `RELEASE_BLOCKED_APP_IMAGE`; app digest/SaaS unavailable                                        |
| `S11-T08` | template PASS; final report BLOCKED | 73-row generator, collector and validator                                         | 73 rows / 69 NOT_RUN / 4 EXCLUDED                                                               |

## Gate Evidence

| Gate                             | Exit code | Result                                                                               |
| -------------------------------- | --------: | ------------------------------------------------------------------------------------ |
| fixture generation and `--check` |         0 | PASS; deterministic 6-file manifest                                                  |
| provider input preflight         |         2 | BLOCKED; 34 missing variable names, no values logged                                 |
| `test:performance` in probe mode |       127 | BLOCKED; `PERFORMANCE_K6_UNAVAILABLE`                                                |
| `test:security`                  |         0 | 5 files / 12 tests PASS for local matrix                                             |
| `test:recovery`                  |         0 | 2 files / 7 tests PASS                                                               |
| full contract suite              |         0 | 23 files / 113 tests PASS                                                            |
| phase1 e2e surfaces              |         0 | 2 files / 6 tests PASS                                                               |
| unit suite                       |         0 | Turbo 22/22 PASS                                                                     |
| typecheck                        |         0 | Turbo 12/12 PASS                                                                     |
| ESLint / Prettier                |         0 | full repository checks PASS                                                          |
| architecture / forbidden files   |         0 | both PASS                                                                            |
| OpenAPI / inventory / runtime    |         0 | `92/120/139/8`, `73/12/57/4`, `110/10`                                               |
| base Compose config              |         0 | PASS                                                                                 |
| release Compose config           |         0 | PASS                                                                                 |
| worker build                     |         0 | Turbo 11/11 PASS                                                                     |
| tenant tests                     |         1 | BLOCKED: `KB_TEST_MONGO_URI` missing                                                 |
| fault tests                      |         1 | BLOCKED: real Mongo test environment missing                                         |
| app build                        |         1 | environment failure: Next package resolves through a link outside the clean worktree |

### Post-Rebase Rechecks

| Gate                     | Result  | Evidence                                                                                                                   |
| ------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| S10 merge ancestor       | PASS    | `git merge-base --is-ancestor d7e38c7... 4c2a59b...` exit 0                                                                |
| Contract / runtime       | PASS    | `92/120/139/8`; `120 / 0`; inventory `73/12/57/4`, Mongo 23, profiles 4, queues 13                                         |
| Contract suite           | PASS    | 24 files / 119 tests                                                                                                       |
| Unit service suite       | PASS    | 28 files / 130 tests                                                                                                       |
| Unit web/app/contracts   | PASS    | 23 files / 88 tests                                                                                                        |
| `pnpm install` in S11    | PASS    | exit 0; `pnpm-lock.yaml` unchanged                                                                                         |
| Security + recovery      | PASS    | 10 + 2 files / 21 tests                                                                                                    |
| Tenant                   | PASS    | 10 files / 19 tests with local real Mongo/PG/Redis/MinIO                                                                   |
| Fault                    | PASS    | 12 files / 39 tests with local real Mongo/PG/Redis/MinIO                                                                   |
| Concurrency              | PASS    | 10 files / 22 tests                                                                                                        |
| S10 integration slice    | PASS    | 5 files / 17 tests                                                                                                         |
| Full service integration | PARTIAL | 28 passed files; 5 files blocked by tests that default to hostname `mongo` and need an explicit `KB_MONGO_URI` alias       |
| Archive/build            | FAIL    | `pnpm build:workers` PASS; `pnpm build` fails because `projects/app/node_modules/next` is a symlink outside Turbopack root |

The app-build failure is an environment/dependency-layout blocker, not a
release PASS. No explicit `pnpm install/add/update/remove` command was issued.
One temporary Windows scratch checkout invocation let pnpm's
`verify-deps-before-run` try an implicit install; it failed on ignored build
scripts, its temporary `pnpm-workspace.yaml` placeholder was removed, and the
tracked lockfile stayed at the W4 hash. The implementation and evidence
worktree used pre-existing WSL dependency links, not a new install.

## Provider Matrix

| Provider                          | Real status | Phase1 evidence                                                          |
| --------------------------------- | ----------- | ------------------------------------------------------------------------ |
| AIProxy                           | BLOCKED     | variables absent; contract adapter tests PASS                            |
| Sangfor / Somark / TextIn / Doc2X | BLOCKED     | profile variables absent; contract shapes PASS                           |
| Feishu                            | BLOCKED     | app/folder/document variables absent; HTTP refresh/pagination tests PASS |
| Yuque                             | BLOCKED     | user/token/repo/TOC variables absent; HTTP IDs/retry tests PASS          |
| DingTalk                          | BLOCKED     | app/user/workspace/root variables absent; token/pagination tests PASS    |

Missing provider fields were reported by name only. No credential, token,
cookie, raw response body, objectKey or connection string was written to
evidence. Real Provider verification remains for post-S10 execution.

## License And Release

The five approved-2026-10-29 entries are `argparse@2.0.1`,
`caniuse-lite@1.0.30001814`, `jschardet@3.1.1`, `pako@1.0.11`, and
`sax@1.6.1`. Exact parent chains, obligations, license texts and source links
are in `scripts/license-obligations.data.json` and generated `NOTICE`.

| Artifact                                   | SHA-256                                                            |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `NOTICE`                                   | `d9d5e614499d9e24af1aaa7dd8adefe8c88752cda99c919d7c3e0ecec081f195` |
| `artifacts/sbom.json`                      | `a49bfe6f5a35bae8b6faec2a305ac96cd367f3860bd68830f2838f28d1001ea5` |
| `docs/acceptance/s11-capability-matrix.md` | `278c69b52b794162835c1588311e36a4aba9632d5f844a7cc9eb2a9b05fab12b` |
| `test/fixtures/s11/fixture-manifest.json`  | `44998778494b8abdd3da9eb93e86c36b143e209d8b82224f60643c573435ec51` |
| `scripts/license-obligations.data.json`    | `09ff0d671766a7bc65fff30bc673934fd7533535b53409bc4cc8aeb2f785dd75` |
| `deploy/release-images.data.json`          | `0f47327e6d0e2ab5eba1fa386d011d2944ee2b865d516cf36a5c88804d97b9b1` |

Five third-party runtime digests are pinned. App/worker production Registry,
tag, linux/amd64 digest and SaaS staging are still missing. Therefore release
is `BLOCKED`, not PASS.

## Security, Performance, Recovery, UI

- Security: local high/serious/critical/secret/cross-tenant assertions are
  0; S10 real API-key scope and rotation are `BLOCKED`.
- Performance: k6 unavailable; no full thresholds, qps, percentiles, fixture
  hash or hardware acceptance is claimed.
- Recovery: Mongo/Redis/PostgreSQL/MinIO tools and real media are unavailable;
  empty-prefix and invariant tests are local only.
- UI: all 18 canonical pages are now present after S10; raw page registry tests
  pass. Final 18×3=54 viewport evidence is not generated because the app build
  is blocked by the current Turbopack dependency layout.

## C7, Pricing And Quota

- C7: `BLOCKED`. Runtime is now `120/0`, but no real API Key, real
  AIProxy/OCR/connector credentials, or full Source-to-Citation-to-Delete chain
  has been executed.
- Pricing: `zero-v1` remains the default; `fixture-v1` and its integer
  micro-point calculation are not exercised against S10 usage facts.
- Quota: `free-v1` is unchanged; `s11-perf-v1` exists only as a performance
  fixture. No quota-window, 429 side-effect, eventId dedupe or terminal Outbox
  assertion is claimed.
- Storage/index limits: no million-Segment or storage-byte acceptance is
  claimed; `maxIndexes` is not converted into a storage estimate.

## Capability Matrix

`docs/acceptance/s11-capability-matrix.md` contains exactly 73 unique rows:
69 `NOT_RUN` development rows and 4 `EXCLUDED` zero-implementation guards.
The 69 blocking IDs, 33 cross-cutting IDs and 4 excluded guards are complete.
No `PASS` row is present in phase1.

## Hold Point

The implementation stops at the external-input/release gate. S10 is merged,
the S11 worktree is installed, and local post-rebase tests are largely green,
but the build layout and real Provider/k6/image/SaaS prerequisites are not yet
complete. Candidate, personA/personB evidence and W4 wave evidence must not be
created before those gates are resolved.
