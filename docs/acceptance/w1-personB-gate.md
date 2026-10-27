# W1 personB Gate

## Decision

Status: `PASS`

Scope: `W1 personB read-only gate`

W1 wave closure: `PENDING_PERSONA_EVIDENCE`

- Wave: `W1`
- Stage role: `personB independent gate`
- Stage under review: `S4 / personB` with parallel `S5 / personA`
- Candidate owner: `personA`
- Candidate branch: `feat/kb-s05-model-parse`
- Candidate SHA: `d20da2511b185f9274bd7520d4fb935d68593f44`
- W1 base SHA: `4cf765b2d82496f74e92eb27327a2358c92fe928`
- S4 merge SHA: `506ed2c07edcd02219d1824a5271e283a6022c2b`
- Worktree: `/home/archer/RAG-agent-platform-w1-d20da251`
- Owner of this gate: `personB`
- Git state: detached checkout at the supplied candidate SHA

The candidate was checked out independently. PersonB did not edit, rebase,
install, push, create a PR, merge, or commit on the candidate branch. The
tracked worktree was clean before the gate and is clean after the gate.

This PASS certifies the personB command gate and candidate facts listed below.
It does not by itself close W1. Wave closure still requires the updated personA
evidence, the corrected S5 stage evidence, this evidence's integration by
personA, and the final W1 wave evidence.

## Candidate Preflight

| Check                                                   | Result                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `git rev-parse HEAD`                                    | PASS: `d20da2511b185f9274bd7520d4fb935d68593f44`                         |
| `git status --porcelain` before gate                    | PASS: empty                                                              |
| `git merge-base --is-ancestor <S4 merge> HEAD`          | PASS: exit `0`                                                           |
| Remote branch head                                      | PASS: `git ls-remote` equals candidate SHA                               |
| Candidate commit                                        | `fix(kb-s5): close W1 phase2 integration`                                |
| Candidate commit time                                   | `2026-10-27 15:09:27 +0800`                                              |
| Candidate lockfile                                      | PASS: `3b0cea949ba6285d572aa0541fe83c1d91fcbb98eac5dc25eae24dfdd438ba13` |
| Candidate `node_modules/.pnpm/lock.yaml`                | PASS: same SHA as candidate lockfile                                     |
| PersonB tracked edits                                   | PASS: none                                                               |
| Final `git status --porcelain=v1 --untracked-files=all` | PASS: empty                                                              |

Diff context:

- `base..HEAD`: 160 files changed, 24,728 insertions, 781 deletions.
- `S4 merge..HEAD`: 102 files changed, 10,845 insertions, 184 deletions.
- No files deleted between the S4 merge and the candidate.
- All 116 unique `TEST-*` IDs present at the S4 merge remain present.

## Dependency View

The prior directory-only overlay is superseded and is not used as proof for this
run.

- Archive: `w1-full-dependency-view-d20da251.tar.gz`
- Archive bytes: `293,944,590`
- Archive SHA-256: `6aca2e41368388232a0242f94a3b6b24849e3efaeeb0567b3f3e969816172a8f`
- Usage README SHA-256: `65df0dd8b3d7311ebfac15b97489d3a43d1fcc6460c259bf5a6a0aeb43e8e979`
- Source lockfile SHA-256: `3b0cea949ba6285d572aa0541fe83c1d91fcbb98eac5dc25eae24dfdd438ba13`

The complete view was extracted into the candidate worktree only after the
archive size, SHA, and README were checked. The first extraction encountered
the two package directories left by the superseded overlay:

```text
packages/parse/node_modules/@llamaindex/liteparse-wasm
packages/parse/node_modules/@types/turndown
```

Both absolute paths were verified to be inside the candidate worktree, the two
ignored directories were removed, and the full archive was extracted again
successfully. No tracked path was removed.

Required installed-view checks:

| Path                                                                  | Result        | SHA-256                                                            |
| --------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------ |
| `node_modules/.modules.yaml`                                          | PASS: present | `519489a750d69cac9042fd8f6906ac365157e9db0430b6e3ef5274e3d489b501` |
| `node_modules/.pnpm/lock.yaml`                                        | PASS: present | `3b0cea949ba6285d572aa0541fe83c1d91fcbb98eac5dc25eae24dfdd438ba13` |
| `projects/app/node_modules/next/package.json`                         | PASS: present | `7bd991b2e608539915711fc0286a87de7bfcea244e9edaef4a031da7c0d74904` |
| `packages/parse/node_modules/@llamaindex/liteparse-wasm/package.json` | PASS: present | `4077d90306df71d8fa28de02d1a140139206ea5108937abbe074528bedbf0871` |
| virtual-store LiteParse 2.0.8 package                                 | PASS: present | covered by package manifest above                                  |

`projects/app/node_modules/next` resolves inside the candidate's own
`node_modules/.pnpm` directory. It no longer points into the separate S4
worktree.

No `pnpm install/add/update/remove` command was executed by personB.

## Environment

```text
date=2026-10-27 17:39:11 +08:00
node=v22.23.2
pnpm=10.33.4
git=2.34.1
kernel=Linux 6.6.87.2-microsoft-standard-WSL2 x86_64 GNU/Linux
docker_server=29.6.2
docker_compose=5.3.1
timezone=Asia/Shanghai
```

MongoDB, Redis, pgvector/PostgreSQL, and MinIO were healthy before the gate.
The candidate nvm Node installation was used for every pnpm command.

## Contract, Runtime, And Capability

| Check                           | Result                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------- |
| Target contract                 | PASS: `92 paths / 120 operations / 139 schemas / 8 parameters`                  |
| Runtime / deferred              | PASS: `83 / 37`                                                                 |
| Runtime/deferred intersection   | PASS: `0`                                                                       |
| Runtime/deferred union          | PASS: `120`                                                                     |
| Capability inventory            | PASS: `73 total / 12 BASE / 57 DATA / 4 EXCLUDED`                               |
| W1 capability scope             | PASS: all 22 S4+S5 candidate capabilities are present in the canonical manifest |
| Baseline plus W1 reporting      | 6 accepted baseline capabilities plus 22 W1 capabilities = 28 implemented       |
| W1 open capability              | `DOWN-004` remains `DATA`; therefore the wave-level closed count remains 27     |
| S6 or later operation promotion | PASS: none found                                                                |
| `DOWN-004`                      | PASS: remains `DATA`, owned by S4 scope and closed only by S10 API Key work     |

Capability interpretation:

- The canonical manifest intentionally keeps W1 capabilities at `DATA`; it is
  an inventory status, not a substitute for the wave evidence's
  implemented/closed ledger.
- PersonB verified the 22 W1 candidate capability IDs, their required test
  families, and `DOWN-004 = DATA`.
- The stale S5 stage evidence prevents personB from certifying personA's final
  28/27 declaration inside this report. PersonA must update the S5 evidence
  before writing the W1 wave evidence.

S4 runtime operations, all present:

```text
API-IMPORT-FILES
API-IMPORT-TEXT
API-IMPORT-URL
API-IMPORT-TEMPLATE
API-IMPORT-BACKUP
API-IMPORT-API-CATALOG
API-IMPORT-API-LIBRARY
API-CONNECTOR-CONNECT
API-CONNECTOR-CATALOG
API-CONNECTOR-IMPORT
API-CONNECTOR-SYNC
API-CONNECTOR-UPDATE
API-CONNECTOR-GET
API-CONNECTOR-DELETE
```

S5 runtime operations, all present:

```text
API-MODEL-LIST
API-MODEL-BINDING-GET
API-MODEL-BINDING-UPDATE
API-MODEL-BINDING-VALIDATE
```

## Command Evidence

`outputHash` is SHA-256 of the captured command log, including the command
header.

| Command                                                                                                       | Exit | Result                                                                        | outputHash                                                         |
| ------------------------------------------------------------------------------------------------------------- | ---: | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `git status --porcelain`                                                                                      |    0 | PASS, empty                                                                   | `2c7a6205396c6cef4c47912b11de8f29dd810229a10d1f2233bcd77f453d4e79` |
| `git rev-parse HEAD`                                                                                          |    0 | PASS                                                                          | `ece63b3aec6d99c51253ec1ccc5d519df6cc7559f5604851b91015e4265d2cb2` |
| `git show -s --format='%H %ci %s' HEAD`                                                                       |    0 | PASS                                                                          | `d6e1611b7442c1740f5f18f93769a17b73612bba94018634e4b449c34339b1b3` |
| S4 ancestor check                                                                                             |    0 | PASS                                                                          | `08650b79b04d8fd6a23c30b0497b83a7834ad0305ca09efe97838eb3e6b29440` |
| W1 union checker                                                                                              |    0 | PASS                                                                          | `121cbe06abb4e61d4133f9cad171b8ac5307cd15dfa61152e2b34501d3fa9334` |
| `pnpm openapi:generate`                                                                                       |    0 | PASS                                                                          | `34c9eb7a930776919df8405b0e022b45b4554e62db15d52d884bcf0088d5cd1f` |
| `git status --porcelain` after generate                                                                       |    0 | PASS, empty                                                                   | `2c7a6205396c6cef4c47912b11de8f29dd810229a10d1f2233bcd77f453d4e79` |
| `pnpm openapi:check`                                                                                          |    0 | PASS                                                                          | `2b6cc8d1b9afd30075e52ae1cc3b012f8d84034cbafec9d40494bccc166947a3` |
| `pnpm knowledge:inventory`                                                                                    |    0 | PASS                                                                          | `e2098eec7ee7c5b9717e4bcb99c622f7471aba6089a888d602c2527338a9f746` |
| `pnpm knowledge:check-runtime`                                                                                |    0 | PASS                                                                          | `32d99ae604cb020bd750f7ede31ce732b0a53e226e3e0f09cdf7995ec54607a1` |
| `pnpm lint`                                                                                                   |    0 | PASS                                                                          | `0d410dbd66f14b1ae514324f5eebc29080bce9add15159e24a72689e81cb40b8` |
| `pnpm format:check`                                                                                           |    0 | PASS                                                                          | `bac74601078a146e9ff574640af6af95b5f30d9f478208dc7d8bd7bd11ddec00` |
| `pnpm typecheck`                                                                                              |    0 | PASS: 12/12 packages                                                          | `4d6ec1bd89a600e7b2d71fa0c45cb2c1faf0ba249531e9e81ae23e103d71e4ac` |
| `pnpm architecture:check`                                                                                     |    0 | PASS                                                                          | `aebeba730f1c2e604522d527e412baec27393883fe2690c9715f4ac97bee7d08` |
| `pnpm forbidden-files:check`                                                                                  |    0 | PASS                                                                          | `fbcf3ca787e928da6c750160b1daf1fb702967e552b382dbd74e029254796429` |
| `pnpm license:check`                                                                                          |    0 | PASS: 684 production components                                               | `c5dd0635e138d29fb070e23339809bd42524403fa811af9645de40f155d6a199` |
| `pnpm sbom:generate`                                                                                          |    0 | PASS: direct 132 / transitive 1,398 / workspace 12 / image 4                  | `fb817ef4c289d9daf9c6b93ba893c3a4d2f0d42d0b669739f9e6d7b93ada645b` |
| `git status --porcelain` after SBOM                                                                           |    0 | PASS, empty                                                                   | `2c7a6205396c6cef4c47912b11de8f29dd810229a10d1f2233bcd77f453d4e79` |
| `pnpm test:unit`                                                                                              |    0 | PASS: 21/21 tasks; 212 tests                                                  | `b40a01289d47b71dd3e300fd284881cf8e816bc1e328c66b405d41efc669743a` |
| `pnpm test:contract`                                                                                          |    0 | PASS: 13 files / 75 tests                                                     | `78b07208732bb90ee80f8d29c0ff9545bf6f602e72c91e18d8259c5e66f87c1d` |
| `pnpm test:integration`                                                                                       |    0 | PASS: 21/21 tasks; service 13 files / 97 tests                                | `3647019ae7aa24b338f8540ed2db99dcd9adaa94368a2858d78b5ec2d2e4182b` |
| `pnpm test:tenant`                                                                                            |    0 | PASS: 4 files / 11 tests                                                      | `6cebe93ebac605d7da52460bea31ea8b4e7817fc615f92c7bcd0e5a1ae9d8c8f` |
| `pnpm test:concurrency`                                                                                       |    0 | PASS: 5 files / 12 tests                                                      | `3029adc9d6911f194366f60a98a75fe5f7ce123969abb44e34633c3b0c04b832` |
| `pnpm test:fault`                                                                                             |    0 | PASS: 5 files / 24 tests                                                      | `32dfdc76cee675d3035e0fb9f76afc9edba8a45dc393fa7c04e3b613d03f600c` |
| `pnpm build`                                                                                                  |    0 | PASS: 12/12 tasks; Next.js production build complete                          | `444cef13b87b31e2f928e75b8b1027fa47af77d5bc48a00b948586d83f4666ba` |
| `pnpm build:workers`                                                                                          |    0 | PASS: 10/10 tasks                                                             | `7e17038a31d060a485454dc859fba486315bf5aa102fa20226c7f2a8483a66b2` |
| `pnpm test:e2e`                                                                                               |    0 | PASS: 5 files / 34 tests                                                      | `25912d3445dfaef0dd58999292efe4198625e9cfa95bdfc7e3f107c643e9697e` |
| default Compose config                                                                                        |    0 | PASS                                                                          | `1d0d5c89371732cd3b310e71a0c0245f0d75f0fd713d968d8d49592be5e4d382` |
| `aiproxy` profile Compose config                                                                              |    0 | PASS                                                                          | `83f22c96706aa7cf60d434afcea7cb1e2633b1a4e6c41394beaa098ac3cd230f` |
| E2E immediate status                                                                                          |    0 | Test-generated S3 screenshots modified and `docs/acceptance/s5-ui/` untracked | `c8a55feef1cefe1d3908bc3d32979e3e723712fdda49e30d4595fcc1d5240164` |
| `git status --porcelain` after S3 image restore                                                               |    0 | Only generated `docs/acceptance/s5-ui/` remained                              | `18ea041936e636e1b54438c9fdb81fec81f8bb61af83a90ea1d89e3cd2616572` |
| Final `git status --porcelain=v1 --untracked-files=all` after moving generated S5 images outside the worktree |    0 | PASS, empty                                                                   | `a802a1767d759e26b2b6d1df9b0b2b80475f19a52ea19e96b209664e93f18b77` |

S3 screenshot restoration was performed from the candidate's own `HEAD` after
the E2E suite. The generated S5 screenshots were not deleted. They were moved,
with hashes, to the external evidence directory described below.

## Test IDs

The candidate contains 130 unique `TEST-*` IDs. The S4 merge contains 116 unique
`TEST-*` IDs, and the W1 union checker found none missing from the candidate.

| Family          | Candidate unique IDs |
| --------------- | -------------------: |
| `TEST-ING-`     |                   26 |
| `TEST-API-002`  |                    2 |
| `TEST-DOWN-004` |                    5 |
| `TEST-MODEL-`   |                    5 |
| `TEST-KB-002`   |                    2 |
| `TEST-PARSE-`   |                    7 |

The required S4 blocking IDs passed in the contract, integration, tenant,
concurrency, fault, build, and E2E suites. The required S5 blocking IDs passed
in unit, contract, integration, tenant, concurrency, fault, build, and E2E.

`DOWN-004` S4 entry, tenant, idempotency, parent-Job, and scope subsets passed.
The report does not claim the S4 fixture subset closes the S10 API Key portion.

## C1/C2/C6 And Scope Audit

- C1 S4 commit side: Source drafts, one parent import Job with N Sources, Audit,
  and Outbox are covered by integration, concurrency, and fault suites.
- C1 remains a producer-side proof. S4 QueuePort fake use remains test-only, and
  no real Outbox-to-Worker consumer is claimed before S6.
- C2 S5 parse/chunk/QA: format matrix, OCR fallback, processing, QA, artifact,
  tenant, and fault suites pass. No S6 Job or Segment execution is claimed.
- C6: S5 model/OCR usage and outbox behavior passed service integration and
  concurrency tests. Real external model and OCR providers remain unverified.
- S4 and S5 runtime operations are active, while S6 and later operations remain
  deferred.
- No old Dataset route, collection, queue, `modeldata`, or 1536-only DDL
  regression was reported by the runtime and forbidden-files checks.

## Dependency And License Audit

`pnpm license:check` passed and reported:

- 12 workspace packages.
- 132 catalog entries.
- 684 production npm components.
- SBOM component set consistent with `artifacts/sbom.json`.
- Five `pending-legal-review` release blockers. They block release, not this CI
  gate:
  - `argparse@2.0.1`, Python-2.0.
  - `caniuse-lite@1.0.30001814`, CC-BY-4.0.
  - `jschardet@3.1.1`, LGPL-2.1+.
  - `pako@1.0.11`, MIT AND Zlib.
  - `sax@1.6.1`, BlueOak-1.0.0.

The additional dependency-only command also exited 0:

```text
pnpm license:check --dependency-only
dependency gate PASS: 166 ledger, 166 audit, 132 catalog, 12 workspace packages
```

The catalog total of 132 is the W1 union. The lockfile did not change during
this gate.

## Side Effects And Real/Mock State

No tracked candidate file changed during this personB run.

Test/build side effects:

- MongoDB, Redis, PostgreSQL/pgvector, and MinIO integration resources were used
  through the test environment. Tests created and cleaned their isolated test
  records/objects.
- Build outputs and Turbo caches were written to ignored directories.
- `pnpm sbom:generate` rewrote reproducible SBOM/NOTICE outputs, and the
  post-SBOM `git status` was empty.
- E2E wrote screenshots. The untracked S5 screenshots were moved to:

```text
/home/archer/RAG-agent-platform-w1-d20da251-evidence/generated/s5-ui/
```

Generated S5 screenshot hashes:

| File                      | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `s5-model-parse-1200.png` | `3557246412d1b7c060557653848ac26012640fd749af5b7b83b29402d0ccba83` |
| `s5-model-parse-360.png`  | `919136c44c8e7ef5d43e1c8ae8bbc2428b791ea894c7e888e4cd4c53e10ebfee` |
| `s5-model-parse-768.png`  | `7738a449e3b0bd8aa5120f548039655e52fede8e9c7905d352d284e55f01b780` |
| `SHA256SUMS`              | `b8cc8ccc751b82ccff516318e6a01cf59e2c9f49e302eaf1e5aaf207cec7f75e` |

Container side effect:

- The existing candidate `aiproxy` profile was started with
  `--pull never --no-build`.
- The local gateway and its independent PostgreSQL became healthy.
- Both containers were stopped after the smoke test.
- A new named AIProxy PostgreSQL data volume was created by the local Compose
  profile and was not deleted.
- No image pull, push, build, or external provider write was performed.

## External Verification

- Local AIProxy gateway: `PASS_REACHABLE`.
- `/api/status`: HTTP 200.
- `/v1/models`: HTTP 200, `{"data":[],"object":"list"}` using the local
  container-injected admin key.
- The key was not printed, stored, or included in this evidence.
- The empty model list proves only that the gateway API is reachable. It does
  not prove that an upstream model is usable.
- Real LLM, VLM, STT, TTS, OCR, Feishu, Yuque, DingTalk, and custom API
  integrations remain `EXTERNAL_UNVERIFIED`.

## Evidence Hashes

```text
pnpm-lock.yaml
3b0cea949ba6285d572aa0541fe83c1d91fcbb98eac5dc25eae24dfdd438ba13

runtime-registry.data.json
54837c89f2a0fb3fb0408c1e773ff2ee8ec07acb7f69f5226adb6b24e807f875

deferred-manifest.data.json
d830bfb742d65fbdfc1cecdd30fdd68465a0ed2aaa6973031fcde0c16a508802

knowledge-target.openapi.json
038a91ccb0e54515e00ebd6e06cc7e84df01dd6c96debf2721bc35a973046c8e

S5 fixture manifest
3b595682e3997b9bef549e5976633c32e13730f992f84f9fc2a24e436720b325

environment
6694b95c264a7c8e605c27b835922c6b85c21674a72e4ea81b7685bf56efc0d2

results.tsv
3dcbae796e64c94bdb7ebc9be17afbd35dd385655a8196fe08afa4338617ea41

AIProxy status response
a72c27dedd4aaccfa1c741b7f4dd3213c50bae78202aa997a33267378f5b0d34

AIProxy models response
49c64eb258b2e815adaa6659b3b88661bf7379c254b63407784dc15b8769f1ac
```

## Findings And Residual Risks

- `docs/acceptance/s5-model-parse-stage.md` still states phase 1,
  `BLOCKED_WAITING_FOR_S4_MERGE_SHA`, `NOT_PRODUCED`, `NOT_FROZEN`, and
  `NOT_CREATED`. This contradicts the frozen candidate and must be corrected by
  personA before wave closure.
- No `docs/acceptance/w1-personA-gate.md` exists in the candidate yet. The W1
  wave cannot close until personA creates it for the same candidate SHA.
- This report is personB evidence only. It must be integrated by personA in an
  evidence-only commit without changing the candidate's product files.
- The canonical manifest cannot machine-prove the wave-level "implemented" and
  "closed" labels. PersonB verified the 22 W1 capability IDs, their blocking
  test families, and `DOWN-004 = DATA`; the final 28/27 declaration must be
  consistent across the personA gate and wave evidence.
- `DOWN-004` remains `DATA`. S10 owns the real API Key closure.
- Five legal-review release blockers remain release-blocking, even though
  `license:check` exits 0.
- External providers remain `EXTERNAL_UNVERIFIED`.

## Required Next Action

PersonA should:

1. Update `docs/acceptance/s5-model-parse-stage.md` to the frozen candidate.
2. Write `docs/acceptance/w1-personA-gate.md` against candidate
   `d20da2511b185f9274bd7520d4fb935d68593f44`.
3. Integrate this personB evidence without changing product files.
4. Write `docs/acceptance/w1-wave-evidence.md` only after both gate reports
   agree on the same candidate, runtime/deferred values, Capability ledger, and
   external-unverified status.

CI URL is intentionally omitted. Review/PR Review must bind the final CI URL.

## Evidence Files

```text
/home/archer/RAG-agent-platform-w1-d20da251-evidence/results.tsv
/home/archer/RAG-agent-platform-w1-d20da251-evidence/environment.txt
/home/archer/RAG-agent-platform-w1-d20da251-evidence/check-w1-union.mjs
/home/archer/RAG-agent-platform-w1-d20da251-evidence/logs/
/home/archer/RAG-agent-platform-w1-d20da251-evidence/generated/s5-ui/
/home/archer/RAG-agent-platform-w1-d20da251-evidence/w1-personB-gate-blocked-before-full-view.md
```
