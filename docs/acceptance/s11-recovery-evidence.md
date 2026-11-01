# S11 Recovery Evidence

Result: real isolated drill `PASS`; overall S11 remains `SCOPED_BLOCKED`.

Candidate: not frozen.

The repeatable drill was rerun from implementation checkpoint `e68b00a`; it is
not a frozen candidate gate.

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
Redis keys: 18 / 18
MinIO objects: 3 / 3
Outbox + Usage event IDs: 3 unique, 0 duplicate
Vector profiles: 4 unique, 0 duplicate
```

Evidence:

| Artifact         | SHA-256                                                            |
| ---------------- | ------------------------------------------------------------------ |
| generate summary | `cca7560c25f61feef91c4c64ac7bc89bd7f5b3066107040e85568a233315bdc6` |
| consume summary  | `87c5bad91ac57ebdbba4e1e2882cc610e64bfec645ddbc0ccecdc90c43d89b28` |
| input manifest   | `836cf524a95dc637d4a6da6341a051734d49a7bacbebd134bf3c92db88915ff4` |
| Mongo archive    | `23d025d049c5330ddfb15df97e91069782f14493d9c3eeb7a0c59a5fe87fe386` |
| PostgreSQL dump  | `c71dea5f65c42eb50f83941ea4f9bc02b7a8b2219a07813b400ea34e012e7c0d` |
| Redis RDB        | `e92dd6633c19352f733de669e6d0dab9847a801beb159310b03f6fe1986a0664` |
| MinIO directory  | `5e648687a671fbf0dcfbed8f9957d3305f08dec439d57fb3696d8422fe1bfd94` |

The drill ran with `candidateSha=UNFROZEN`; it does not by itself authorize
candidate freeze or W4 completion.
