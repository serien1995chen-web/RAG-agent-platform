# S10 Audit Acceptance

## Status

- Task: `S10-T03`
- Candidate: `82478af398322b5027b9f715bb5dfd4748211d17`
- Result: `PASS`

## Delivered

- Existing audit collection extended with API Key prefix, request identity,
  IP/User-Agent hashes, safe diff and expiry.
- Query supports action, actor, resource, outcome, time and cursor filters.
- Service-level update and delete methods reject with `KNOWLEDGE_FORBIDDEN`.
- `safeAuditDiff` bounds depth, key count, array size and string length.
- Exact content/identity keys and credential-like substrings are redacted while
  safe metadata such as `promptVersion` remains visible.
- Audit failure participates in the usage transaction and rolls back usage and
  outbox writes.

## Blocking Evidence

| Test ID                   | Result | Evidence                                                                 |
| ------------------------- | ------ | ------------------------------------------------------------------------ |
| `TEST-OPS-003-BLOCK`      | PASS   | `packages/service/test/integration/s10-audit.test.ts`, `s10-ops.test.ts` |
| `TEST-S10-AUDIT-ROLLBACK` | PASS   | `s10-usage-quota.test.ts`                                                |
| `TEST-X-SECRET-LEAK`      | PASS   | `test/security/s10-audit-redaction.test.ts`, `s10-secret-leak.test.ts`   |
| `TEST-X-TENANT-GUARD`     | PASS   | `test/tenant/s10-ops-tenant.test.ts`                                     |

## Commands

- `pnpm test:integration`: exit 0, service 33 files / 179 tests.
- `pnpm test:security`: exit 0, 5 files / 9 tests.
- `pnpm test:tenant`: exit 0, 10 files / 19 tests.

## Risks

- Append-only enforcement is at the repository/service boundary. A database
  administrator with raw write access can bypass application guards.
