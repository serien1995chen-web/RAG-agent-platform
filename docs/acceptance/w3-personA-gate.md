# W3 PersonA Gate

## Result

- Wave: `W3`.
- Stage / owner: `S9 / personA`.
- Parallel stage: `S8 / personB`.
- Result: `PASS`.
- W3 baseline: `13fa0e9be84edd33ea5cc5413d64282c126dd117`.
- S8 merge SHA: `9839b2a1005ce7fdf4558ea8d002ae1ab6dcadbd`.
- Candidate SHA: `a5768dfa008756a2695ac148b01476e7e3d72ad6`.
- Candidate parent: `03fc6f0a47d4aa9328cd78d54baea4fa3b05913b`.
- Candidate subject: `fix(worker): resolve deployment runtime dependencies`.
- Superseded candidate: `03fc6f0a47d4aa9328cd78d54baea4fa3b05913b`.
- Superseded personB result: `FAIL`, missing `yauzl` in deployment worker.
- Worktree: `/home/serien/RAG-agent-platform-s09`.
- HEAD at gate start: `a5768dfa008756a2695ac148b01476e7e3d72ad6`.
- `git status --porcelain` at gate start: empty.
- S8 merge is a candidate ancestor: `yes`.

This gate did not edit source, rebase, install dependencies, alter the lockfile,
push, create a PR or merge.

## Environment

| Item                      | Value                                      |
| ------------------------- | ------------------------------------------ |
| OS                        | Ubuntu 22.04 on WSL2                       |
| Kernel                    | `6.18.33.2-microsoft-standard-WSL2 x86_64` |
| Node.js                   | `v22.23.2`                                 |
| pnpm                      | `10.33.4`                                  |
| Mongo                     | local replica set, `directConnection=true` |
| PostgreSQL                | local pgvector profile                     |
| Redis                     | local queue/idempotency instance           |
| Object storage            | local MinIO `kb-local`                     |
| Model provider            | repository AIProxy mock fixture            |
| OCR / connector providers | repository mock fixtures                   |
| FastGPT Cloud             | `EXTERNAL_UNVERIFIED`                      |
| External cloud Providers  | `EXTERNAL_UNVERIFIED`                      |

Container image digests:

```text
minio     sha256:a63b19df59e6ec7c02ebba6e7a1097b7e032da7947b18db7ff67dae8e84fd44d
mongo     sha256:ab12670508974afbdf3bdc7dd39a201d228a73c9c13c70a684b9eedfb063dc3e
pgvector  sha256:92be4ea0424cccf17003f5803d54448e2864ac27a70e6ac5d24b3d8b463c689c
redis     sha256:2bf71743152d3ca631d358029d504fed349ea28179667acfa755dffb4b321e7c
aiproxy   sha256:da8d8394634eacdcf72533953c77c1e0ca3e28920545354dd20bdaa0aaa9ee4b
```

## Commands

Every command below exited `0` unless explicitly described as a live-process
probe. Logs are outside the worktree under `/tmp/s9-persona2/`.

| Command                                              | Exit | Key output                                 | Log SHA-256                                                        |
| ---------------------------------------------------- | ---: | ------------------------------------------ | ------------------------------------------------------------------ |
| `git status --porcelain`                             |    0 | empty                                      | n/a                                                                |
| `pnpm lint`                                          |    0 | PASS                                       | `d17a90ee9563886c7bfe9916811725e5e623668b4d6e600d92b8b3fe1644f20d` |
| `pnpm format:check`                                  |    0 | all files formatted                        | `989c1becd7e598bb16d7801eede19cfce7686a07a9d8d3f8396ec8ee14084299` |
| `pnpm typecheck`                                     |    0 | 12 packages                                | `eb733f334f2047ad9ec7e2c85c460ad565630f50a8a37a0bbe86c70ba7dacca6` |
| `pnpm architecture:check`                            |    0 | 133 sources / 12 packages                  | `66971862b40704220f72905c533fe0e34a26c6911149a6dff8f5509462318cdd` |
| `pnpm forbidden-files:check`                         |    0 | 544 files                                  | `3b57cec6bb3e68d82943e6cecda27b7f7aba158504cf02c6f61825098ad2e062` |
| `pnpm license:check`                                 |    0 | five release blockers pending legal review | `686303def25a72c87cfe02aab2583deeac8e01956fb9ecb7847bd393bfd7c8b8` |
| `pnpm openapi:check`                                 |    0 | `92/120/139/8`, runtime `110/10`           | `7cc34ff75cd45c77b02502b860de58c32539d7a1a17dc33943309f3f60632251` |
| `pnpm knowledge:inventory`                           |    0 | `23/4/13`                                  | `a5e118d6ffd1dbd3fee6e8e9b2cb05eeefd92124964781236cde25b24d5b6988` |
| `pnpm knowledge:check-runtime`                       |    0 | `110/10`, intersection `0`, union `120`    | `add0c841b544bf2dcaaaebc37a040765368d0386c318615eedcb4d7b656ae9f0` |
| `pnpm sbom:generate`                                 |    0 | no tracked diff                            | `c77e43ae12ac32b8eb63e12e9ae4d444081df073d516185b10b5be50bd90632c` |
| `pnpm build`                                         |    0 | 12 packages                                | `fad44cda2a98ca89501e64fbfb6d9b8214336b17af555d292011128d685b4397` |
| `pnpm build:workers`                                 |    0 | worker bundle complete                     | `f187be1cc6d46454013fcc1ea6d3e87aa47ed1f3ea5fd319d12e2758345c0ee2` |
| `docker compose -f deploy/docker-compose.yml config` |    0 | 342 lines                                  | `bf10017c84ec56a1c8b3307c182102414855af41ed874bab1bebc9dff9eb8435` |
| `pnpm test:unit`                                     |    0 | Turbo `22/22`; 349 tests                   | `db88e529adb86d165d43a672c527897dbb71912aa5b19d8fd5636ca1cbc51b7c` |
| `pnpm test:contract`                                 |    0 | 20 files / 96 tests                        | `8911c0e0aabeb51fb58b943c291685a2de989e7c5291a4f22d80e3b14ab0d478` |
| `pnpm test:integration`                              |    0 | Turbo `22/22`; 196 tests                   | `c9c40a7e7d9ec95959a82be7ed31da5a5fb9b3367b9128e9fd631a5883ff4bd1` |
| `pnpm test:tenant`                                   |    0 | 8 files / 17 tests                         | `74b07783429088d35bfb53723760ed1f0e3d9f852917a68f9918e01130b88e3e` |
| `pnpm test:concurrency`                              |    0 | 8 files / 16 tests                         | `f293af7069729501939979f973365e981826039ee55098787c16c783e9d079a2` |
| `pnpm test:fault`                                    |    0 | 10 files / 34 tests                        | `5969ecd16fae93e2e2173d1d7e47ce7475eb10fd93005596585ff5182c30e70b` |
| `pnpm test:e2e`                                      |    0 | 14 files / 58 tests                        | `bb2cb20d811d43a84114380eb0d2dd810168f790f947cd7ce6e25e22209f56db` |
| `pnpm test`                                          |    0 | full sequence                              | `4831130d6c0131e0aeb67d4600b5a625836d37fa4f46410ecd882a7290b87556` |

Integration counts by package:

```text
service 163
parse    18
qa        9
storage   4
dal       2
total   196
```

## Deployment Worker Gate

The exact deployment-style worker command was executed with no manual
`NODE_PATH`:

```text
node projects/app/dist/workers/worker.mjs
```

Observed state while live:

```text
ready_marker=present
knowledge_queue_meta=13
knowledge_queue_stalled_check=13
```

The readiness log SHA-256 is
`46ce8ba8e41dfeae1bc484862b579c8a214011a12c8057cf399f03e06e3105db`.

After `SIGTERM`, the worker exited, no matching process remained, and the
readiness marker was absent. The post-exit process log is empty with SHA-256
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

The worker bundle now derives the workspace root from its own path and includes
the pnpm hoisted dependency view in formal `NODE_PATH`. The Docker runner also
declares `/app/node_modules/.pnpm/node_modules:/app/node_modules`. A contract
test asserts both layers.

## Contract And Capability

| Check             | Result                       |
| ----------------- | ---------------------------- |
| Paths             | `92`                         |
| Operations        | `120`                        |
| Schemas           | `139`                        |
| Parameters        | `8`                          |
| Runtime           | `110`                        |
| Deferred          | `10`                         |
| S8 runtime        | `2 / 2`                      |
| S9 runtime        | `8 / 8`                      |
| Mongo collections | `23`                         |
| Vector profiles   | `4`                          |
| Queues            | `13`                         |
| W3 Capability     | `53 implemented / 49 closed` |
| DOWN-001...004    | `DATA`                       |

The eight S9 Operations are:

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

## UI Evidence

The real `PAGE-SYNONYMS` route passed at 360, 768 and 1200 pixels with no
horizontal overflow and serious/critical axe violations equal to zero.
Images, Search/Deep and Synonyms entries remain present. Rebuild progress reads
the existing Job list.

Current personA screenshot hashes:

| Viewport | SHA-256                                                            |
| -------- | ------------------------------------------------------------------ |
| 360      | `37e9b8b6063256a7e2265ac9816f0df1a7536f1be88b3d8037f3176361ef9599` |
| 768      | `31ba156d28213d1e0b3bc1241c7db325e03345ff8d0af2106ee8a6faf9005481` |
| 1200     | `9881b6f1c45031dca9a5c1004cc1a23c062952bf824ec42fc4735a5653276b1e` |

The E2E suite regenerates tracked S8 acceptance screenshots. Those files were
restored to their candidate bytes after each run; no S8 artifact is part of this
evidence-only change.

## Installation And Lockfile

- PersonA gate executed no package installation.
- User installation history remains the S8 pause and the post-rebase S9
  installation.
- Lockfile SHA-256:
  `a12d7b5430abfb013b6af52dbabc6d6a30c0b96b4f6f48d1a4d0454b3a691e7f`.

## Risks

- PersonB must rerun at `a5768dfa008756a2695ac148b01476e7e3d72ad6`.
- The previous `03fc6f0` personB `FAIL` evidence cannot be reused.
- W3 is not complete until personB returns same-SHA PASS evidence.
- CI, Review and PR Review have not run for the new candidate.
- Five dependency license items remain pending legal review for release.
- External cloud Providers and FastGPT Cloud remain `EXTERNAL_UNVERIFIED`.
- A prior parallel integration run exposed one archive retry timing failure.
  It passed standalone and the new candidate integration and full `pnpm test`
  gates passed; it remains a residual flake risk.

## Evidence Change

This file is the personA-only gate artifact at the new candidate. It does not
change code, lockfile, generated files or configuration. A future evidence
commit must contain this file, personB's new evidence unchanged, and the wave
summary under `docs/acceptance/**` only.
