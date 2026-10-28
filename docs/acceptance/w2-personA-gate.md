# W2 PersonA Gate

## Status

- Result: `PASS` for the personA side at candidate
  `d237c028b514a923920cbc36bcb1bb71ee4d9747`.
- Wave / stage / owner: W2 / S7 / personA.
- Parallel stage: S6 / personB.
- Branch: `feat/kb-s07-search-citation`.
- W2 baseline: `87ba3bdea3d7daf3e738a04998b80b49cbf7a77b`.
- S6 merge SHA: `bc091a1513ec0a0b0b2b9412f0c8a397192ea3de`.
- S6 candidate / evidence: `c398593db550e6d4832a24642b368f11bac22ff8`
  / `e6ca0d309f59cc69d018d8f79c8029fc809913a2`.
- Candidate SHA: `d237c028b514a923920cbc36bcb1bb71ee4d9747`.
- Evidence commit SHA: `PENDING_DOCS_ONLY_EVIDENCE`.
- Worktree at gate start: clean, zero porcelain entries.
- S6 ancestor check: exit `0`.
- PersonA: `PASS`.
- PersonB: `PASS` on the same candidate.
- PersonB evidence SHA-256:
  `e770f48a8879b2faedce378415ba4dd930343660347c7bd29305eb7d0d490a9c`.
- Wave W2: `BOTH_LOCAL_GATES_PASS_PENDING_CI_AND_REVIEW`.

This is independent personA evidence. PersonB returned an independent PASS for
the same candidate without installing dependencies. W2 is not complete until CI
runs at the docs-only evidence commit and Review/PR Review binds that result.

## Environment

- OS: WSL2 Ubuntu 22.04.5 LTS.
- Node.js: `v22.23.2`.
- pnpm: `10.33.4`.
- Docker: `29.6.2`, build `dfc4efb`.
- Mongo: `mongodb://127.0.0.1:27017/kb_w1_test` with
  `replicaSet=rs0&directConnection=true`.
- Redis: `redis://127.0.0.1:6379/0`.
- PostgreSQL: `postgresql://kb:kb_dev_password@127.0.0.1:5432/kb`.
- MinIO/S3: `http://127.0.0.1:9000`, bucket `kb-local`.
- Running Compose services at gate: `aiproxy`, `aiproxy-postgres`, `minio`,
  `mongo`, `pgvector`, `redis`.
- External model, embedding, rerank and OCR credentials: not supplied.

E2E used isolated mock-auth credentials and test-only secrets passed through
environment references. Secret values are not recorded in this evidence.

## Candidate Identity

```text
HEAD=d237c028b514a923920cbc36bcb1bb71ee4d9747
commit=d237c028b514a923920cbc36bcb1bb71ee4d9747
date=2026-10-28 13:42:31 +0800
subject=feat(s7): integrate search and citation with s6
```

`git merge-base --is-ancestor bc091a1513ec0a0b0b2b9412f0c8a397192ea3de HEAD`
exited `0`. The S6 candidate and evidence SHAs are also ancestors of HEAD.

## Commands

All commands ran from the clean candidate worktree and exited `0`. Logs were
stored outside the repository under `/tmp/w2-persona-d237c02-v3`.

| Gate                 | Command                                                      | Exit | Key result                             | Log SHA-256                                                        |
| -------------------- | ------------------------------------------------------------ | ---: | -------------------------------------- | ------------------------------------------------------------------ |
| Clean start          | `git status --porcelain`                                     |    0 | empty                                  | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| Diff whitespace      | `git diff --check`                                           |    0 | PASS                                   | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| Lint                 | `pnpm lint`                                                  |    0 | PASS                                   | `44a324755a0f8558e6dfa740802cbf0c5764fd89ec64d2136f1ced111481ce5a` |
| Format               | `pnpm format:check`                                          |    0 | PASS                                   | `8903dade39c192573add1286b2da34e1ec38823f4981527a5b7edb99b2f2844c` |
| Typecheck            | `pnpm typecheck`                                             |    0 | `12 / 12` tasks                        | `613a5fdd0098997e4178ce5dfd8108cb2368f9e265d3c3e8818294673080330b` |
| Architecture         | `pnpm architecture:check`                                    |    0 | 112 sources, no cycles                 | `b2bf454a144e44809c159533fdd39ae76c1fec942ef9643f611dbe7991618285` |
| Forbidden files      | `pnpm forbidden-files:check`                                 |    0 | 471 files, PASS                        | `7cb2785f815fd3a71307d7fcf08b2d0dfc06a8607ca37753b1bc67a49891ed33` |
| License              | `pnpm license:check`                                         |    0 | 159 catalog, 5 release blockers        | `97a7e942f768950bb585d91a54f1682e210f0665b1156ec4237d6f294fc56cae` |
| SBOM                 | `pnpm sbom:generate`                                         |    0 | 159 direct, 1639 transitive            | `82dc4de98ccb1a9043d7ccd767ff7ea30497b7e2a6f387f8a90e257ddd1b31b8` |
| OpenAPI              | `pnpm openapi:check`                                         |    0 | `92 / 120 / 139 / 8`, runtime `100/20` | `cafbd9698b69a1dbd68f5012f4e6d93de8ac0ec1da5e918499f31019aa531bdd` |
| Inventory            | `pnpm knowledge:inventory`                                   |    0 | runtime `100`, deferred `20`           | `85fb788bd460e612f706b14a8d46de6f0c5f0c1851d59eb186411ac3c9d441be` |
| Runtime check        | `pnpm knowledge:check-runtime`                               |    0 | intersection `0`, union `120`          | `e611d99b6b2024e93364855cc9119a53d92455516b0d84ccefdb8de05b448165` |
| Unit                 | `pnpm test:unit`                                             |    0 | Turbo `22 / 22` tasks                  | `75fbae993bdd4c4d96b2faf1c9a3f671ed956ccd84b95ac3e1fa466a47dd59d3` |
| Contract             | `pnpm test:contract`                                         |    0 | `90 / 90` tests                        | `6c800112225cc286d069c4fa863425cf400823326957ebbbf80a3527171ab11f` |
| Integration          | `pnpm test:integration`                                      |    0 | Turbo `22 / 22`; service `129 / 129`   | `980855cbc74e8dd0d7d0d3c3319ffddd74082988b9bebeed29419630c86da37b` |
| Tenant               | `pnpm test:tenant`                                           |    0 | `15 / 15` tests                        | `7e6bfe467ad5d59ca3ba3c1558b59eac01b8032dec2e5a5fe536adb94d6db523` |
| Concurrency          | `pnpm test:concurrency`                                      |    0 | `13 / 13` tests                        | `418dd26dafe7c1c127076c700f4fe2e0761fefab959602b02f37bbbaf62c68d9` |
| Fault                | `pnpm test:fault`                                            |    0 | `32 / 32` tests                        | `d56d7b59144ff412ae39f67b033954309c13227543799d5d3b210f53da14ea59` |
| E2E                  | `pnpm test:e2e`                                              |    0 | `41 / 41` tests in nine files          | `ebe602b413734ca42e5d0db32580d42c51177df032fe4c4e8a847a7cedc7b429` |
| Build                | `pnpm build`                                                 |    0 | Turbo `12 / 12` tasks                  | `fd15b9a6eb74d8b3161824095c683999171cf95ebb1c8d4372edc0f9c4d38e13` |
| Worker build         | `pnpm build:workers`                                         |    0 | Turbo `11 / 11` tasks                  | `59d8f4f8c06aa5c0a9b42bf1e59cfaa3c6ee26672bc19ddd4fe8942cf24db3ca` |
| Compose config       | `docker compose -f deploy/docker-compose.yml config --quiet` |    0 | PASS                                   | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| Clean after evidence | `git status --porcelain` after screenshot restore            |    0 | empty                                  | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

The legacy E2E suite rewrites six tracked S3/S5 screenshot paths by design. Those
test-generated image changes were restored from candidate HEAD after the run;
the empty status log above proves the tracked candidate remained clean. No code,
lockfile, generated contract or configuration changed during the gate.

## Contract And Runtime

- Contract: `92 paths / 120 operations / 139 schemas / 8 parameters`.
- Runtime/deferred: `100 / 20`.
- Runtime intersection: `0`; runtime union: `120`.
- S6 runtime operations: `12 / 12`.
- S7 runtime operations: `5 / 5`.
- Mongo collections: `23`.
- Vector profiles: `4`.
- Canonical queues: `13`.
- Old page routes: `0`.

## Test IDs

| Test ID                                   | Result | Evidence                                                 |
| ----------------------------------------- | ------ | -------------------------------------------------------- |
| `TEST-SEARCH-001-BLOCK`                   | PASS   | Semantic recall, S6 vector output, final ACL             |
| `TEST-SEARCH-002-BLOCK`                   | PASS   | Mongo full-text, RRF, hybrid partial/degraded            |
| `TEST-SEARCH-004-BLOCK`                   | PASS   | Model gateway, rerank, weights, budget and deadline      |
| `TEST-SEARCH-005-BLOCK`                   | PASS   | Safe filters, tag operators, dedupe, similarity and trim |
| `TEST-SEARCH-007-BLOCK`                   | PASS   | Real two-Space S6 index plus multi-space merge           |
| `TEST-SEARCH-009-BLOCK`                   | PASS   | 24-hour HMAC citation, TTL, snapshot and ACL             |
| `TEST-X-SEARCH-REAUTH`                    | PASS   | Revoked/disabled/deleted/stale candidates rejected       |
| `TEST-X-TAG-FILTER-TYPES`                 | PASS   | All approved tag operators and safe-regex behavior       |
| `TEST-DOWN-001-BLOCK` S7 subset           | PASS   | Chat contract: HTTP-only client and degraded result      |
| `TEST-DOWN-002-BLOCK` S7 subset           | PASS   | Agent contract: parameters and no internal import        |
| `TEST-DOWN-003-BLOCK` S7 subset           | PASS   | Workflow citation contract; capability remains DATA      |
| `TEST-X-FRONTEND-A11Y` / `ACC-UI-01...07` | PASS   | Search UI at 360/768/1200, axe and sanitization          |

## C3 / C6

C3 real-data pass:

- Two distinct Spaces were indexed through the real S6 `knowledge-index` Job.
- S7 read the resulting `knowledge_segments.indexes[]`, full-text projection,
  full-text versions and pgvector 768 rows.
- S7 full-text and vector recall returned the same Segment/Source IDs written
  by S6.
- The multi-space application returned both indexed Spaces with distinct
  citation provenance.
- Current Mongo ACL and revision/version checks rejected stale or unauthorized
  candidates after recall.

C6 S7 pass:

- Search scope and tenant isolation.
- ACL reauthorization and failed-search audit.
- Partial/degraded status behavior.
- Citation GET reauthorization.

No S10 API Key lifecycle or admin surface was implemented.

## Capability

- DATA implemented / closed: `47 / 43`.
- S7 closed: `SEARCH-001`, `SEARCH-002`, `SEARCH-004`, `SEARCH-005`,
  `SEARCH-007`, `SEARCH-009`.
- `DOWN-001`, `DOWN-002`, `DOWN-003`: `DATA`.
- Canonical capability manifest remains `DATA`.

## Dependency View

- Archive: `w2-full-dependency-view-d237c028b514.tar.gz`.
- Shared Windows path:
  `C:\Users\Administrator\Desktop\知识库2.0\S7任务\w2-artifacts\w2-full-dependency-view-d237c028b514.tar.gz`.
- Shared WSL path:
  `/mnt/c/Users/Administrator/Desktop/知识库2.0/S7任务/w2-artifacts/w2-full-dependency-view-d237c028b514.tar.gz`.
- PersonA source location:
  `/home/serien/w2-artifacts/w2-full-dependency-view-d237c028b514.tar.gz`.
- Archive bytes: `330234672`.
- Archive SHA-256:
  `06dfb143539921d14245fdd81fdc6f180d9239d7c21192accda39e414d2878a7`.
- Final lockfile SHA-256:
  `31756b79284db42258c9140ca3c9c7ccb195d819633b05b6eaa3de7d0e59e72f`.
- The archive contains root and workspace `node_modules` layouts plus
  `pnpm-lock.yaml`.
- PersonB may extract it into the same candidate checkout for read-only gate use
  and must not run `pnpm install`.
- PersonB extracted the archive, verified the same lock hash and completed the
  independent gate without installing or modifying candidate files.

## Real / Mock / External

- Real verified: Mongo replica set, Redis, PostgreSQL/pgvector, MinIO, S6
  Job/Index writes, S7 reads, ACL checks, app build and browser E2E.
- Mock verified: deterministic embedding/rerank gateway and downstream
  Chat/Agent/Workflow fixtures.
- External unverified: external embedding/rerank providers, S10 API Key
  lifecycle, production IAM and provider billing/quota.

## Risks And Pending Work

- CI must run at the final docs-only evidence commit and its URL must be bound by
  Review/PR Review.
- PersonB evidence is preserved byte-for-byte at
  `docs/acceptance/w2-personB-gate.md`.
- Five pre-existing `pending-legal-review` release blockers remain; they block
  release, not this CI gate.
- `DOWN-001...003` remain `DATA`; `DOWN-004` was not modified.
- S11 was not implemented or modified.
