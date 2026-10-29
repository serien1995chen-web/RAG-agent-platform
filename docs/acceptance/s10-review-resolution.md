# S10 Review Resolution

## Binding

- Wave / stage / owner: `W4 / S10 / personB`
- Previous review head: `ff4289de89d74295c0f710a8d5a21ddc6bce25ef`
- Fixed implementation candidate: `319dbd4bf9b5e3a956c475beb8a1c950fcb47cd2`
- W4 baseline: `14a3b9e96fcab7b6a1f1e92ccdf4dc775719ee7d`
- Result: `PASS`

## I-01 Model Cost Precheck

Resolved:

- Model requests compute conservative `pointsMicros` reservations before provider work.
- Reservation occurs after the concurrency slot is acquired.
- RPM is consumed only after points, storage/index and slot checks pass.
- Over-quota requests return 429 before Provider, Job, Source, Outbox, Usage or RPM changes.
- Points reservations are released on Provider failure.

Evidence:

- `packages/service/test/unit/s5-model-gateway.test.ts`
- `test/concurrency/s10-quota-concurrency.test.ts`
- `packages/service/test/integration/s10-usage-quota.test.ts`

## I-02 Target Outbox Replay

Resolved:

- Replay Jobs persist `outboxEventId` and post-CAS `outboxVersion`.
- Worker calls `dispatchById(eventId, expectedVersion)` and never falls back to `availableAt`.
- A competing pending event is untouched.
- Final shared-usage delivery failure CAS-updates Outbox to `dead_letter` and Usage delivery to `failed`.

Evidence:

- `packages/service/test/integration/s5-usage-outbox.test.ts`
- `packages/service/test/integration/s10-ops.test.ts`
- `packages/service/test/unit/s10-ops-worker.test.ts`

Test IDs: `TEST-X-OUTBOX-CRASH`, `TEST-S10-REPLAY-CAS`,
`TEST-X-OUTBOX-USAGE-FAILURE`.

## I-03 Cleanup Scope Isolation

Resolved:

- `ttl_objects` selects expired pending, temporary and export candidates.
- `orphan_objects` uses active Source lookup protection and selects unreferenced ObjectRefs.
- The same candidate batch is no longer reused for both scopes.

Evidence:

- `packages/service/test/integration/knowledge-file-lifecycle.test.ts`
- Test ID: `TEST-OPS-004-SCOPE`.

## I-04 Failure And Repair Semantics

Resolved:

- Cleanup retryable/failed counts cause a failed retryable Job instead of successful commit.
- Worker has a second guard that refuses cleanup success when unresolved items remain.
- Object repair counts only successful version CAS updates.
- `repair=true` fulltext drift and outbox drift fail explicitly when repair is not implemented.
- Step evidence records the failed scope and reason.

Evidence:

- `packages/service/test/unit/s10-ops-worker.test.ts`
- `test/fault/s10-ops-fault.test.ts`
- Test IDs: `TEST-X-PGVECTOR-PARTIAL`, `TEST-S10-NO-FAKE-COMPLETE`.

## I-05 Status Probe Errors

Resolved:

- Queue and connector query failures are represented as `degraded / UNKNOWN`.
- Failed probes are never converted to empty healthy collections.
- OpsStatus exposes explicit `queueProbe` and `connectorProbe` values.
- Overall status remains `degraded` when either query fails.

Evidence:

- `test/fault/s10-status-probe.test.ts`
- `packages/service/test/unit/s10-status.test.ts`
- `test/contract/s10-ops-contract.test.ts`

## I-06 One-Time Secret Mutation Cache

Resolved:

- Create and rotate copy the secret into local display state.
- Both mutations are reset and the MutationCache is cleared immediately after copying.
- Close and unmount paths purge both mutations and the MutationCache.
- E2E checks `data-size=0` and `data-secret-present=false` while the secret is visible and after close.

Evidence:

- `projects/app/src/pages/settings/api-keys.tsx`
- `test/e2e/s10-ops-admin.test.ts`
- Test ID: `TEST-S10-APIKEY-SECRET-UI`.

## Re-run Evidence

| Command                 | Result         | Log SHA-256                                                        |
| ----------------------- | -------------- | ------------------------------------------------------------------ |
| `pnpm lint`             | PASS           | `580ee9acae7364530ea4bd97e1fd60a83d6fc13f8a003a6a208f41ad581cbc04` |
| `pnpm format:check`     | PASS           | `911dbe799ac892770842a0f6d6ba2dd93cc9f5dcca3e8f17ad6c727630906dbd` |
| `pnpm typecheck`        | PASS           | `ed1c15620ac45106310def3847e1deb64407e49185753852931bab5c643a4554` |
| `pnpm test:unit`        | service 28/129 | `d1a3b2ab6392beaf9ad196e7e027e7c191394c6ff2439565ca71ff42c558237a` |
| `pnpm test:contract`    | 21/100         | `3c6444f81433cdc76a7802f8c69080e473645c66d82011e1ab702bd066bd840c` |
| `pnpm test:security`    | 5/9            | `f7d4e9ddd99e656c1a133a8d3e153009779b1e31fde19ac41a6eda60ba9b2616` |
| `pnpm test:integration` | service 33/179 | `c33fa5aa184d5a31cc70d20ca798e8740f28d7dde579af6166892d474912b1da` |
| `pnpm test:tenant`      | 10/19          | `04ebf102bd7c5e5d6b556f8302402d06c5687bc614086f9fe64f44817f7f86ea` |
| `pnpm test:concurrency` | 10/21          | `ebf003e07a30a6d7657dadad5d94de92626e44c9e7de0322caaf56eadcb19325` |
| `pnpm test:fault`       | 12/38          | `5320dfdf5d5fef60abfc61a426732fbc5138c43ecdffaa19a6a14d47c9dab78e` |
| `pnpm test:e2e`         | 16/67          | `fbffbc5926783924b10a07ef78d129a537001e861f6abbee7ceea6033caa7e29` |
| `pnpm build`            | 12/12          | `8df3aacbd9778b3b173eda99d1cb32e4dc51270b331df21f6bcbe64e34505fcc` |
| `pnpm build:workers`    | 11/11          | `4e8c84d1b551e64acc40f7c8d7ed10b16bff10e947d7ede9755dc4e68b9fdd12` |
| Compose config          | PASS           | `9ac0de71340ab8057b5cd9b8757eb5227ec929c708a1aed58db8a513d557f941` |

Contract/runtime remain `92/120/139/8` and `120/0`.

## Residual Risk

The first full integration re-run hit an existing S6 processing aggregation
transient (`retry` instead of `succeeded`). The same test passed standalone and
the forced full integration retry passed with 33 files / 179 tests. This is
retained as a timing-flake risk.

W4 personB remains `BLOCKED` until personA supplies the candidate SHA, pushed
branch name and S10 merge SHA.
