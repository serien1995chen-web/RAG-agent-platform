# Knowledge Baseline Backup And Restore Runbook

## Scope

- changeId is required for every restore rehearsal.
- This runbook exercises the current `knowledge_*` graph only.
- Mock backup evidence is not a real recovery drill.

## Backup Inventory

- MongoDB: all 23 `knowledge_*` collections, including jobs, Outbox events,
  permissions, object references and audit events.
- PostgreSQL/pgvector: extension state, `knowledge_vector_profiles`, and the
  four dimension tables.
- MinIO/S3: object versions, bucket policy, lifecycle rules and metadata.
- Redis: AOF snapshot for transient BullMQ and rate-limit state. Mongo remains
  the source of durable Job and Outbox state.

## Restore Order

1. Stop API writes and stop workers.
2. Restore MongoDB and verify workspace-scoped collection counts.
3. Restore PostgreSQL/pgvector and verify four profiles and dimensions.
4. Restore MinIO objects and bucket policy.
5. Restore Redis/AOF only after durable stores are consistent.
6. Start dependencies, then app and worker.
7. Verify `/healthz` and `/readyz`.
8. Run tenant, Outbox, job lease and object/vector reference reconciliation.
9. Resume writes and record evidence.

## Pre And Post Checks

- Pre-check: artifact checksum, changeId, source scope, capacity and window.
- Post-check: Mongo collection counts, workspace orphan scan, pgvector profile
  dimensions and HNSW indexes, MinIO object refs, Outbox status, Job leases and
  duplicate idempotency keys.
- A failed check keeps the environment isolated; do not mark the drill PASS.

## Rollback

Use the private delivery tool to restore the previous Mongo, PostgreSQL and
MinIO snapshots. Redis may be rebuilt from durable Mongo/BullMQ state after the
other stores are consistent. Rollback commands must be supplied and approved by
the private operator; this repository does not embed destructive commands.

## Evidence

| Field            | Value |
| ---------------- | ----- |
| changeId         |       |
| operator         |       |
| approvalRole     |       |
| startedAt        |       |
| completedAt      |       |
| checksums        |       |
| beforeChecks     |       |
| afterChecks      |       |
| comparisonResult |       |
| incidentNotes    |       |

## S11 Isolated Recovery Drill

The S11 drill only accepts `kb_s11_` source targets and
`kb_s11_restore_` restore targets. A non-matching target fails before any
command is run.

```bash
node scripts/run-recovery-drill.mjs --check --source-prefix kb_s11_
S11_RECOVERY_MODE=real \
S11_RECOVERY_SOURCE_PREFIX=kb_s11_source \
S11_RECOVERY_RESTORE_PREFIX=kb_s11_restore_target \
S11_RECOVERY_CHANGE_ID="$CHANGE_ID" \
S11_EVIDENCE_DIR="$S11_EVIDENCE_DIR" \
S11_RECOVERY_MEDIA_MODE=generate \
S11_RECOVERY_MEDIA_DIR="$S11_EVIDENCE_DIR/media" \
pnpm test:recovery
```

`generate` creates all four media files, `recovery-input-manifest.json`, and
their SHA-256 hashes from the isolated source before restoring to the isolated
target. `consume` verifies the same manifest and media hashes instead of
generating new files. Both modes require source/restore Mongo, PostgreSQL and
Redis URLs, source/restore buckets, S3 credentials, a health URL and an external
media directory. Raw URIs and credentials are never written to evidence.

The drill compares all 23 `knowledge_*` collection names/counts, four vector
profiles and dimension tables, MinIO object counts, Redis keys and S10
Outbox/Usage event IDs. It writes `recovery-summary.json` and only returns
`RECOVERY_PASS` when `/healthz=200`, `/readyz=200`, hashes match and every count
diff is zero.
