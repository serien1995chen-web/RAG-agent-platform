# Backup And Restore Runbook

## Scope

- changeId: required for every restore or migration rehearsal.
- runbookUri: `docs/runbooks/backup-restore.md`
- runbookVersion: `v1`
- approvalRole: private deployment operator plus data owner.
- rollbackInfo: rollback point, before/after checks, commands, compared fields, and evidence.

This runbook uses mock backup evidence until the private delivery tool and media are supplied. A mock run is not a real recovery, and it must not be recorded as a completed real drill.

## Backup Inventory

- MongoDB business database and `dataset_migrations` / `dataset_migration_logs`.
- PostgreSQL/pgvector database and vector extension state.
- S3 private and public buckets, object policies, and TTL metadata.

## Restore Order

1. Stop writes or switch the application to `readonly` / `block`.
2. Restore MongoDB business data and migration logs.
3. Restore PostgreSQL/pgvector.
4. Restore S3 objects and bucket policies.
5. Start services and run dependency checks.
6. Validate the Migration Registry.
7. Run reconcile dry-run.
8. Apply reconcile or handle differences manually.
9. Resume writes and record drill evidence.

## Pre And Post Checks

- Pre-check: backup artifact checksum, changeId, source scope, storage capacity, and maintenance window.
- Post-check: Mongo counts, pgvector counts and dimensions, S3 object counts, migration log counts, failed rows, reconcile report, and reference integrity.

## Rollback Commands

```bash
# Restore the previous Mongo snapshot with the private tool.
# Restore the previous pgvector snapshot with the private tool.
# Restore the previous S3 bucket state with the private tool.
```

Commands must be supplied by the private delivery tool. Failed rollback keeps the environment isolated for manual handling. Repeated rollback must be safe.

## Data Comparison

| Area        | Before            | After         | Compared fields             |
| ----------- | ----------------- | ------------- | --------------------------- |
| Mongo       | Snapshot manifest | Live counts   | collection, count, checksum |
| PG/pgvector | Snapshot manifest | Live counts   | table, count, dimension     |
| S3          | Bucket manifest   | Live objects  | bucket, key, etag, policy   |
| Migration   | Registry export   | Live registry | version, state, cursor      |

## Drill Record

| Field            | Value |
| ---------------- | ----- |
| changeId         |       |
| operator         |       |
| approvalRole     |       |
| startedAt        |       |
| completedAt      |       |
| backupEvidence   |       |
| beforeChecks     |       |
| afterChecks      |       |
| rollbackInfo     |       |
| comparisonResult |       |
| incidentNotes    |       |
