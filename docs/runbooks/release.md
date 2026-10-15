# Release Runbook

## Release State

`proposed -> migrated -> verified -> kept/rolled_back`

## Required Fields

- changeId
- runbookUri: `docs/runbooks/release.md`
- runbookVersion: `v1`
- rollbackInfo
- approvalRole

## Pre-Release Checks

- Freeze scope, version, maintenance window, and expected write mode.
- Confirm backup requirement and keep the pre-migration backup until verification completes.
- Run migration dry-run and review the diff.
- Confirm rollback point and verification data points.

## Release Steps

1. Record approval and changeId.
2. Enter the declared write mode.
3. Apply the migration.
4. Run count and reference checks.
5. Run reconcile dry-run.
6. Mark the release `verified` and either `kept` or `rolled_back`.

## Evidence Template

| Field              | Value |
| ------------------ | ----- |
| changeId           |       |
| version            |       |
| writeMode          |       |
| estimatedWindow    |       |
| rollbackWindow     |       |
| dryRunReport       |       |
| applyRunId         |       |
| verificationResult |       |
| rollbackInfo       |       |
| approver           |       |
