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
