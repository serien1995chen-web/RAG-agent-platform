# S10 Review Resolution

## Binding

- Wave / stage / owner: `W4 / S10 / personB`
- Previous review head: `ff4289de89d74295c0f710a8d5a21ddc6bce25ef`
- First fix candidate: `319dbd4bf9b5e3a956c475beb8a1c950fcb47cd2`
- Second review candidate: `82478af398322b5027b9f715bb5dfd4748211d17`
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

## Second Review Follow-up

### R2-01 Targeted Outbox Replay

- Pending replay events now persist `replayJobId` until the matching replay Job
  claims them.
- Generic `dispatchOnce` ignores targeted replay events.
- `dispatchById` requires the event ID, expected version and matching replay Job
  ID; a different pending event cannot be delivered by mistake.
- Reusing an Idempotency-Key returns the same Job only when the target and
  expected version match; conflicting reuse returns 409.

Evidence:

- `packages/service/test/integration/s10-ops.test.ts`
- `packages/service/test/integration/s5-usage-outbox.test.ts`
- Test ID: `TEST-S10-REPLAY-CAS`.

### R2-02 Provider Retry Lease Window

- Model concurrency and points reservations now use a 900-second crash-safe
  lease, longer than the 120-second timeout across three Provider attempts.
- A failed Provider invocation still releases both reservations immediately.

Evidence:

- `test/concurrency/s10-quota-concurrency.test.ts`
- Test ID: `TEST-S10-QUOTA-ZERO-SIDE-EFFECT`.

### R2-03 S3 Reconcile Error Classification

- Object reconcile treats only a typed `KNOWLEDGE_NOT_FOUND` response as a
  missing object.
- 403, 503, timeout and untyped network failures remain dependency failures,
  are recorded in step evidence and never trigger ObjectRef repair.
- Non-API dependency errors are rethrown as retryable
  `KNOWLEDGE_DEPENDENCY_UNAVAILABLE`.

Evidence:

- `test/fault/s10-ops-fault.test.ts`
- Test ID: `TEST-OPS-004-S3-ERROR-CLASSIFICATION`.

## Re-run Evidence

| Command                 | Result         | Log SHA-256                                                        |
| ----------------------- | -------------- | ------------------------------------------------------------------ |
| `pnpm lint`             | PASS           | `580ee9acae7364530ea4bd97e1fd60a83d6fc13f8a003a6a208f41ad581cbc04` |
| `pnpm format:check`     | PASS           | `911dbe799ac892770842a0f6d6ba2dd93cc9f5dcca3e8f17ad6c727630906dbd` |
| `pnpm typecheck`        | PASS           | `4590e6b695916c5f89f93c762cf8296e9e922cf6c66d987015a57c8e10496077` |
| `pnpm test:unit`        | service 28/129 | `f492bc7e717f2345ec1a0616cf2f700a40efab714bfd018287f4044c28da8424` |
| `pnpm test:contract`    | 21/100         | `d12d280503ef2dd51837c0694406ed5945e26493ac83861ff347949760223ec4` |
| `pnpm test:security`    | 5/9            | `6b6d8088022e505cbceca5e7151f8fcdd1f06f282ae7675e5497c605628d9be7` |
| `pnpm test:integration` | service 33/179 | `babf12239008ebf237163f349f555578e0440e5febed1f4b2ba2cf3e2d0e7981` |
| `pnpm test:tenant`      | 10/19          | `82074c166136ed428f5ec0baa47765d8f7f050081fb9796c0b97d7f48b77362a` |
| `pnpm test:concurrency` | 10/22          | `d9ff66b744771c9d13be3b98122ef27cf1acf75f663eccff20eed3975a227acc` |
| `pnpm test:fault`       | 12/39          | `d0f37fe186a39d112a1f38bf20f20802d3d9737e401f14ea20fef55b1eeb8b06` |
| `pnpm test:e2e`         | 16/67          | `3db88e507eeeb662afe482ed11455d5924bdf75b35062d9cf93db0fe0737866f` |
| `pnpm build`            | 12/12          | `3ba306e6ab6ed5ed223e49e6f62822bdc1cb46543a820da6fcfa1f8a2ee801eb` |
| `pnpm build:workers`    | 11/11          | `2aa8fc1facd88bc029a06f16b38a4b40e4241fa532a2264e832072076a38395d` |
| Compose config          | PASS           | `9ac0de71340ab8057b5cd9b8757eb5227ec929c708a1aed58db8a513d557f941` |

Contract/runtime remain `92/120/139/8` and `120/0`.

## Residual Risk

The first full integration re-run hit an existing S6 processing aggregation
transient (`retry` instead of `succeeded`). The same test passed standalone and
the forced full integration retry passed with 33 files / 179 tests. This is
retained as a timing-flake risk.

W4 personB remains `BLOCKED` until personA supplies the candidate SHA, pushed
branch name and S10 merge SHA.
