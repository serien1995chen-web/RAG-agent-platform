# S10 API Key Acceptance

## Status

- Wave: `W4`
- Stage: `S10`
- Task: `S10-T01`
- Owner: `personB`
- Candidate: `319dbd4bf9b5e3a956c475beb8a1c950fcb47cd2`
- Result: `PASS`

## Delivered

- Five canonical operations: list, create, update, delete, rotate.
- HMAC-SHA-256 secret hashing, 12-character prefixes, scope and Space scope checks.
- Active, rotated, revoked and expired lifecycle with a bounded 24-hour rotation overlap.
- CAS mutations and chain revocation.
- Create and rotate return a one-time secret; idempotency records retain only a
  `oneTimeSecretReturned` marker.
- Composite authentication accepts real `kn_live_` API Keys without extending the
  fixture auth token path.

## Blocking Evidence

| Test ID                     | Result | Evidence                                                                   |
| --------------------------- | ------ | -------------------------------------------------------------------------- |
| `TEST-S10-API-KEY-001`      | PASS   | `packages/service/test/unit/s10-api-key.test.ts`, service unit log         |
| `TEST-API-003-BLOCK`        | PASS   | `s10-api-key.test.ts`, `s10-api-key-auth.test.ts`, `s10-ops-admin.test.ts` |
| `TEST-S10-API-KEY-CAS`      | PASS   | `test/concurrency/s10-api-key-concurrency.test.ts`                         |
| `TEST-X-TENANT-GUARD`       | PASS   | `test/tenant/s10-api-key-tenant.test.ts`                                   |
| `TEST-X-SECRET-LEAK`        | PASS   | `test/security/s10-api-key-auth.test.ts`, `s10-secret-leak.test.ts`        |
| `TEST-S10-APIKEY-SECRET-UI` | PASS   | `s10-ops-admin.test.ts`, secret cleared from DOM, URL and browser storage  |

The real-key E2E also proves old and new secrets behave correctly across rotation
and revocation. A restricted-Space admin key is rejected by `API-OPS-STATUS`
with `403` before probes run.

## Commands

- `pnpm test:unit`: exit 0.
- `pnpm test:contract`: exit 0, 21 files / 100 tests.
- `pnpm test:security`: exit 0, 5 files / 9 tests.
- `pnpm test:integration`: exit 0, service 33 files / 179 tests.
- `pnpm test:tenant`: exit 0, 10 files / 19 tests.
- `pnpm test:concurrency`: exit 0, 10 files / 19 tests.
- `pnpm test:e2e`: exit 0, 16 files / 67 tests.

## Risks

- The committed HMAC file is a deterministic test fixture. Compose requires a
  separate local secret and refuses to start without a readable file.
- The five existing legal-review items remain release blockers for S11; they are
  not API Key defects.
