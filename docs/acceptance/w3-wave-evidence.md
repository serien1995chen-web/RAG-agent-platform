# W3 Wave Evidence

## Status

- Wave: `W3`.
- Stage: `S9 synonym rebuild`, with parallel `S8 image/Deep` already merged.
- Candidate: `06601f94f15819122a0fa8defd5ef9a013b854a9`.
- Candidate parent: `94a2e93d10f8c18b410d434aaf146d20ab392f6b`.
- W3 baseline: `13fa0e9be84edd33ea5cc5413d64282c126dd117`.
- S8 merge: `9839b2a1005ce7fdf4558ea8d002ae1ab6dcadbd`.
- PersonA local result: `PASS` with a disclosed archive retry flake.
- PersonB independent result: `PASS`.
- Same candidate SHA on both sides: `yes`.
- Worktree at candidate before evidence: clean.
- Remote branch head at candidate: `06601f94f15819122a0fa8defd5ef9a013b854a9`.
- EvidenceCommitSha: the commit containing this file; exact SHA is recorded in
  the handoff and bound by CI/Review/PR Review.
- W3 completion: `NOT_COMPLETE` until CI, Review and PR Review pass on the
  evidence commit.

This file is an acceptance-only summary. It does not replace either owner's
evidence and does not claim that CI or PR Review has passed.

## Evidence Inventory

| Artifact                        | Identity                             | SHA-256                                                            |
| ------------------------------- | ------------------------------------ | ------------------------------------------------------------------ |
| PersonA gate                    | `docs/acceptance/w3-personA-gate.md` | `775debeaa0610017b7d10d8e20a65ee5e67366636dffee5b1cb75f23ea970b25` |
| PersonB gate                    | `docs/acceptance/w3-personB-gate.md` | `00be5107c481e384825f73edc101c4a7ac03f3d3eaa2539fa6eda079a5fac74d` |
| PersonB evidence manifest       | 117 entries                          | `10723eb99303a44da8f5131446cedb45ca92da25a15b922d83027ce16235f494` |
| PersonB log manifest            | 62 entries                           | `acd20bc8a006f6b8c72e9c238e3483ecf3e5e54da6d051390495f307177ac0b7` |
| PersonB UI/S8 hash manifest     | 9 images                             | `229798f102094fd91dc1b229199b83d1039567e35202dd9c009dac6547cf6d2b` |
| PersonB personA-status manifest | READ_AND_HASH_VERIFIED               | `ea3b06984db9fa32b9fbcb69c11a26cda8d4e8f8ddfd6a08817020e12413b918` |

The PersonB gate bytes in `docs/acceptance/w3-personB-gate.md` match the
delivered file. PersonB did not modify or re-sign PersonA evidence.

## Review Closure

| Review item                                            | Closure evidence                                                                                                                                                                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual rebuild reused a terminal Job                   | Manual/model-change keys include the config version. Integration covers a second rebuild after success and after failure, both producing a new queued Job. Concurrency covers one winner for simultaneous requests.                                         |
| 30-day cleanup ignored `cleanupCandidates.availableAt` | S6 cleanup consumes persisted retention candidates through the existing Port. PGVector integration covers switch time, day 29, day 30 and day 31.                                                                                                           |
| Recursive Tarjan overflowed at 10,000 nodes            | Tarjan now uses an explicit frame stack. Domain and operation tests exercise a 10,000-node cascade, structured `CASCADE_REFERENCE`, bounded diagnostics, `truncated=true` and no file-text disclosure. The real HTTP invalid-file path has a 422 assertion. |
| Empty synonym config looked like a permission error    | Config/mapping matching `KNOWLEDGE_NOT_FOUND` with no config renders the empty state. A real empty-Space E2E asserts the empty copy and upload control.                                                                                                     |

All four items are covered by the final candidate tests and by both owner
reports. The personA archive retry exposure is retained as a risk rather than
being hidden or converted into a passing claim.

## Gate Matrix

| Gate                                  | PersonA                        | PersonB                        |
| ------------------------------------- | ------------------------------ | ------------------------------ |
| Candidate / remote head               | `06601f94` / clean             | `06601f94` / clean             |
| Contract                              | `92 / 120 / 139 / 8`           | `92 / 120 / 139 / 8`           |
| Runtime / deferred                    | `110 / 10`                     | `110 / 10`                     |
| Runtime intersection / union          | `0 / 120`                      | `0 / 120`                      |
| Capability implemented / closed       | `53 / 49`                      | `53 / 49`                      |
| Mongo collections / profiles / queues | `23 / 4 / 13`                  | `23 / 4 / 13`                  |
| S8 runtime                            | `2 / 2`                        | `2 / 2`                        |
| S9 runtime                            | `8 / 8`                        | `8 / 8`                        |
| Deferred operations                   | 10 S10 operations              | 10 S10 operations              |
| `DOWN-001...004`                      | `DATA`                         | `DATA`                         |
| Unit                                  | service `23 / 108`             | service `23 / 108`             |
| Contract                              | `20 / 96`                      | `20 / 96`                      |
| Integration                           | service `29 / 165` after retry | service `29 / 165` after retry |
| Tenant                                | `8 / 17`                       | `8 / 17`                       |
| Concurrency                           | `8 / 17`                       | `8 / 17`                       |
| Fault                                 | `10 / 34`                      | `10 / 34`                      |
| E2E                                   | `14 / 59`                      | `14 / 59`                      |
| Full `pnpm test`                      | PASS, Turbo `22 / 22`          | PASS, Turbo `22 / 22`          |
| Static / build / worker / Compose     | PASS                           | PASS                           |

The exact owner log paths and hashes are retained in the two gate files. The
PersonA first integration attempt failed at `TEST-FILE-004-A15`; the file
passed standalone and the forced full integration retry passed. PersonB did
not reproduce the failure.

## Runtime And Boundary

S8 runtime Operations preserved:

```text
API-SEARCH-IMAGE
API-SEARCH-DEEP
```

S9 runtime Operations:

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

Deferred Operations are exactly the ten S10 API Key, Audit, Ops and Usage
operations:

```text
API-APIKEY-LIST
API-APIKEY-CREATE
API-APIKEY-DELETE
API-APIKEY-UPDATE
API-APIKEY-ROTATE
API-AUDIT-LIST
API-OPS-CLEANUP
API-OPS-OUTBOX-REPLAY
API-OPS-RECONCILE
API-USAGE-GET
```

Capability derivation:

- W2: `47 implemented / 43 closed`.
- S8 adds `MULTI-001`, `SEARCH-006`, `SEARCH-008`, `PARSE-005`.
- S9 adds `SEARCH-003`, `TRAIN-006`.
- Result: `53 implemented / 49 closed`.
- `DOWN-001...004` remain `DATA`.

C5:

- S9 uses the existing S6 rebuild/index Ports and S7 query pipeline.
- No synonym module writes vector or full-text rows directly.
- Published synonym state switches only after successful rebuild finalization.
- Failure preserves the previous target and records safe failure evidence.

C6:

- Repository predicates include `workspaceId`.
- Cross-tenant access returns `404`.
- Space/Source ACL and audit facts remain authoritative.
- Job, Outbox and Audit facts remain consumable by S10.

The candidate delta from S8 merge contains no deleted S8 path. S8 vision
embedding, caption, Deep, Images/Search UI, dependencies, tests, registries,
generated artifacts and two runtime operations remain present.

## Worker And UI

Both owners verified the deployment-style command with `NODE_PATH` unset:

```text
node projects/app/dist/workers/worker.mjs
```

Observed on both sides:

```text
ready marker present
knowledge queue meta = 13
knowledge queue stalled-check = 13
SIGTERM clean shutdown
marker removed
no remaining worker process
```

Worker bundle SHA-256:
`75a9ab109d677aaa52a0cc43eb262735773f84bea29cdee8823ddc6fc8e01669`.

The real Synonyms page passed at 360, 768 and 1200 pixels with zero
serious/critical axe violations, no horizontal overflow, keyboard coverage and
operation controls. Images, Deep, Search and Synonyms navigation entries remain
present.

PersonB UI/S8 screenshots are external evidence under
`/home/archer/w3-personB-evidence-06601f94/`; the tracked S8 acceptance
screenshots remain byte-identical to the candidate. PersonA restored the same
tracked files after its E2E run, leaving `docs/acceptance/s8-ui` with no diff.

## Installation And Providers

- PersonA package operations: `0`.
- PersonB package operations: `0`.
- User installation 1: S8 dependency pause.
- User installation 2: post-S9-rebase `pnpm install`.
- Lockfile SHA-256:
  `a12d7b5430abfb013b6af52dbabc6d6a30c0b96b4f6f48d1a4d0454b3a691e7f`.
- `REAL_VERIFIED`: Mongo replica set, Redis, PostgreSQL/pgvector, MinIO,
  canonical HTTP app and Chromium.
- `FIXTURE_VERIFIED`: VLM caption, vision embedding, Deep planner, synonym
  parsing/expansion/rebuild and AIProxy mock.
- `EXTERNAL_UNVERIFIED`: production AIProxy VLM/embedding/rerank credentials,
  vendor vision capability, external FastGPT cloud and IAM/API-key scope.

## Evidence Boundary

The evidence-only commit changes exactly:

```text
docs/acceptance/w3-personA-gate.md
docs/acceptance/w3-personB-gate.md
docs/acceptance/w3-wave-evidence.md
```

It does not change source, tests, lockfile, dependencies, OpenAPI/generated
artifacts or configuration. The candidate remains
`06601f94f15819122a0fa8defd5ef9a013b854a9`.

Any later code, lockfile, rebase, reinstall or provider-state change invalidates
both owner evidence and requires a new candidate and both gates again.

## Risks

- Five dependency/license items remain release-legal blockers for S11.
- Production cloud Providers and FastGPT Cloud remain `EXTERNAL_UNVERIFIED`.
- The PersonA `TEST-FILE-004-A15` archive retry exposure remains a residual
  timing-flake risk; PersonB did not reproduce it.
- CI, Review and PR Review must run on the final evidence commit before W3 can
  be called complete.

## Next

1. Commit these three files under `docs/acceptance/**`.
2. Push the evidence-only commit and record its exact SHA.
3. Run CI at that SHA.
4. Obtain final Review and PR Review approval bound to that SHA.
5. Only then mark W3 complete.
