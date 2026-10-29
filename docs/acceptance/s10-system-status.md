# S10 System Status Acceptance

## Status

- Task: `S10-T05`
- Candidate: `c5d70d704fcdb9f29130fa64b8b027b6c24ad29f`
- Result: `PASS`

## Delivered

- Existing `API-OPS-STATUS` route was extended; no second status route exists.
- Every request performs live Mongo, Redis, PostgreSQL/pgvector and S3 probes.
- Queue lag includes waiting, delayed, active, failed and aggregate lag; legacy
  queue depth is derived from the same live counts.
- Model, connector, security and latest successful reconcile status are exposed.
- `FIXTURE_VERIFIED`, `EXTERNAL_UNVERIFIED` and `UNKNOWN` never become healthy.
- Restricted-Space and non-admin API Keys receive `403` before probing.
- Reconcile orphan counts are derived from persisted Job result items, not hardcoded.

## Blocking Evidence

| Test ID                    | Result | Evidence                                      |
| -------------------------- | ------ | --------------------------------------------- |
| `TEST-OPS-005-BLOCK`       | PASS   | `s10-status.test.ts`, `s10-ops-admin.test.ts` |
| `TEST-S10-STATUS-SECURITY` | PASS   | `test/security/s10-status-security.test.ts`   |
| `TEST-OPS-005-BLOCK` fault | PASS   | `test/fault/s10-status-probe.test.ts`         |

## Commands

- `pnpm test:unit`: service 28 files / 125 tests.
- `pnpm test:security`: 5 files / 9 tests.
- `pnpm test:fault`: 12 files / 37 tests.
- `pnpm test:e2e`: real dependency status is `REAL_VERIFIED`; mock model remains
  `FIXTURE_VERIFIED`; overall result is `degraded`.

## Risks

- External provider credentials remain `EXTERNAL_UNVERIFIED` until S11.
