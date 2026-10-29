# S10 Usage And Quota Acceptance

## Status

- Task: `S10-T02`
- Candidate: `319dbd4bf9b5e3a956c475beb8a1c950fcb47cd2`
- Result: `PASS`

## Profiles

- `zero-v1`: all point prices are zero and is the production default.
- `fixture-v1`: LLM input `1 point/1k`, output `2 points/1k`, embedding and rerank
  `1 point/1k`, page `1`, image `1`, audio `1/60 seconds`.
- `free-v1`: 100 points per 30 days, 30 RPM, 3 Spaces, 600 indexes,
  `10737418240` storage bytes and 10 model slots.
- Points are stored as integer `pointsMicros`; API summaries render six decimals.

## Delivered

- `knowledge_usage_events` now carries `inputTokens`, `outputTokens`,
  `pointsMicros`, `pricingVersion` and immutable `pricingSnapshot`.
- No new collection was added.
- Usage event IDs deduplicate usage, outbox and audit facts.
- Failed and intent-only calls record zero points.
- The production `KnowledgeQuotaGate` covers import, sync, rebuild and model paths.
- The shared usage adapter has profile-aware snapshot caching, bounded ingest and
  snapshot timeouts, and 503/504 dependency errors.
- Outbox delivery transitions usage from `pending` to `delivered` or `failed`.

## Blocking Evidence

| Test ID                           | Result | Evidence                                                    |
| --------------------------------- | ------ | ----------------------------------------------------------- |
| `TEST-OPS-001-BLOCK`              | PASS   | `packages/service/test/integration/s10-usage-quota.test.ts` |
| `TEST-OPS-002-BLOCK`              | PASS   | same file plus `s5-usage-outbox.test.ts`                    |
| `TEST-S10-PRICING-HASH`           | PASS   | `packages/service/test/unit/s10-pricing.test.ts`            |
| `TEST-S10-QUOTA-CACHE`            | PASS   | shared adapter tests and usage integration                  |
| `TEST-S10-QUOTA-ZERO-SIDE-EFFECT` | PASS   | `test/concurrency/s10-quota-concurrency.test.ts`            |
| `TEST-S10-AUDIT-ROLLBACK`         | PASS   | audit failure leaves zero usage and outbox rows             |

## Commands

- `pnpm test:unit`: service 28 files / 129 tests.
- `pnpm test:integration`: service 33 files / 179 tests.
- `pnpm test:concurrency`: 10 files / 21 tests.
- `pnpm test:fault`: 12 files / 38 tests.

## Risks

- Production AIProxy and shared usage credentials remain `EXTERNAL_UNVERIFIED`
  until S11 supplies real deployment credentials.
