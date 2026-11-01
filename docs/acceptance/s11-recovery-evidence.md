# S11 Recovery Evidence

Result: real isolated drill `PASS`; overall S11 remains `SCOPED_BLOCKED`.

Candidate: not frozen.

## Container Tool Probe

`pnpm test:recovery -- --check --source-prefix kb_s11_source` exited `0` and
reported `RECOVERY_CHECK_READY`.

| Service  | Tools                                                     |
| -------- | --------------------------------------------------------- |
| mongo    | mongodump 100.14.0, mongorestore 100.14.0, mongosh 2.5.10 |
| pgvector | pg_dump 15.14, pg_restore 15.14, psql 15.14               |
| minio    | mc RELEASE.2025-08-13T08-35-41Z, curl                     |
| redis    | redis-cli 7.2.11, redis-server 7.2.11                     |

## Local Tests

`pnpm exec vitest run --config test/recovery/vitest.config.ts` passed 2 files /
9 tests. Prefix isolation, secret-free command construction, missing-tool
blocking, media-manifest binding/hash checks and recovery invariants are
covered.

## Real Generate And Consume Drill

The real drill used isolated Mongo/PostgreSQL/Redis/MinIO source and restore
targets with the current local Compose stack.

```text
generate: PASS; differences=0; healthz=200; readyz=200
consume:  PASS; differences=0; healthz=200; readyz=200
Mongo collections: 23 before / 23 after
PostgreSQL profiles: 4
Redis keys: 19 / 19
MinIO objects: 3 / 3
Outbox + Usage event IDs: 3 unique, 0 duplicate
```

Evidence:

| Artifact         | SHA-256                                                            |
| ---------------- | ------------------------------------------------------------------ |
| generate summary | `374a73d084fba196534ebf960434b7e8c6ca1289a1895539c245b4a158a9e663` |
| consume summary  | `e97fe6b348f9694f8085ebb368ee2adf25f42dfb42b512bd099de903176aac7f` |
| input manifest   | `7feadc09a9fddf869d63840da33fb02cad9d494f4c398184a2ef7dfe0dd13844` |
| Mongo archive    | `bf20ac5b7192eab1650672dc6087819daba08dfc6ddb7bed89f34742138f9a7e` |
| PostgreSQL dump  | `039aa140638382b389ec0db6d7811ae2cb180b03519e4624143000716330004d` |
| Redis RDB        | `c6826975b51026dd8a0e855389abf76375b533f868647b8af68818cdb63f3905` |

The drill ran with `candidateSha=UNFROZEN`; it does not by itself authorize
candidate freeze or W4 completion.
