# Release Rollback Runbook

## Required Fields

- changeId
- runbookUri: `docs/runbooks/release-rollback.md`
- runbookVersion: `v1`
- rollbackInfo
- approvalRole

## Rollback Procedure

1. Stop affected writes.
2. Preserve logs, failed resources, and the current migration cursor.
3. Select the recorded rollback point.
4. Execute rollback commands from the private delivery tool.
5. Run before/after checks and data comparison.
6. Validate reference integrity.
7. Resume writes only after approval.

## Rollback Commands

```bash
# Use the private delivery tool commands recorded in rollbackInfo.
# Do not run destructive commands without changeId approval.
```

## Data Comparison

- Mongo collection counts and checksums.
- PostgreSQL/pgvector table counts and dimensions.
- S3 object manifests and bucket policies.
- Migration registry state, cursor, and failure rows.

## Drill Record

| Field | Value |
| --- | --- |
| changeId | |
| rollbackPoint | |
| rollbackInfo | |
| operator | |
| approvalRole | |
| beforeChecks | |
| commands | |
| afterChecks | |
| comparisonResult | |
| repeatedRollbackSafe | |
| incidentNotes | |

Failed rollback keeps the environment isolated for manual handling. The backup is not deleted before verification completes.
