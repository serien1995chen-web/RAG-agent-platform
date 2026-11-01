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
| generate summary | `6722a024ba8b1bc0f307dfb9f63460c5a2a5a50dc773aa4985604043a9b86be2` |
| consume summary  | `60148a1c6c5a200ccf37880004a738fa98b8e09ddf35bf828e426d731efd4c4f` |
| input manifest   | `888f0b553de19b63e810ffff57571de82b802c5245868c53d491db518bdd93b5` |
| Mongo archive    | `dfbd1a6a7b97685791b1c300744d45c76d5b46cc37243dd20d4e97510a9155ab` |
| PostgreSQL dump  | `0df57817efcc73138724ea6bd8a508ce3d574a527160e270f9f9cdc5258faeaa` |
| Redis RDB        | `5a472727cf651383103630b051a95e994907fd49b70dc6ec3671221c6b4342ac` |

The drill ran with `candidateSha=UNFROZEN`; it does not by itself authorize
candidate freeze or W4 completion.
