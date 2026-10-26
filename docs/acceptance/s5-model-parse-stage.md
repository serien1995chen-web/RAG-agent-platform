# S5 Model and Parse Stage Evidence

## Status

- Wave / stage / owner: W1 / S5 / personA
- Parallel stage: S4 / personB
- Branch: `feat/kb-s05-model-parse`
- Baseline: `4cf765b2d82496f74e92eb27327a2358c92fe928`
- personB merge SHA: `NOT_PRODUCED`
- candidate SHA: `NOT_FROZEN`
- evidence commit SHA: `NOT_CREATED`
- Phase 1: implementation and independent gates PASS
- Phase 2: `BLOCKED_WAITING_FOR_S4_MERGE_SHA`

This document is phase 1 evidence only. It does not claim Wave W1 completion,
runtime promotion, S4 integration, candidate freeze, or dual-owner evidence.

## Scope

- Tasks: S5-T01 through S5-T09.
- Capabilities: `KB-002`, `MODEL-001...006`, `PARSE-001...004`.
- Operations: `API-MODEL-LIST`, `API-MODEL-BINDING-GET`,
  `API-MODEL-BINDING-UPDATE`, `API-MODEL-BINDING-VALIDATE`.
- C2: parse/chunk/QA output is returned to the future S6 caller; S5 writes no
  Job, child Job, Segment, search record, or index record.
- C6: model and OCR attempts write idempotent usage facts plus pending outbox
  records in Mongo transactions.
- Shared runtime, route allowlist, route registry, public API client, shared
  navigation, shared i18n entry points, and worker registration are not changed.

## Gates

| Gate               | Result                                         | Evidence                                                |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------- |
| Contract inventory | PASS, `92/120/139/8`, runtime `65/55`          | `openapi:check`, `knowledge:inventory`, `check-runtime` |
| Atomic steps       | PASS, 9 Tasks x 12 fields; 72 steps x 9 fields | Plan audit                                              |
| Lint / format      | PASS                                           | `pnpm lint`, `pnpm format:check`                        |
| Typecheck          | PASS, 12 packages                              | `pnpm typecheck`                                        |
| Architecture       | PASS                                           | `pnpm architecture:check`, `forbidden-files:check`      |
| Unit               | PASS, Turbo 20/20 tasks; all S5 unit suites    | `pnpm test:unit`                                        |
| Contract           | PASS, 50 tests                                 | `pnpm test:contract`                                    |
| Integration        | PASS, Turbo 20/20; service 72; S5 part 22      | `pnpm test:integration`                                 |
| Tenant             | PASS, 9 tests                                  | `pnpm test:tenant`                                      |
| Concurrency        | PASS, 9 tests                                  | `pnpm test:concurrency`                                 |
| Fault              | PASS, 18 tests; S5 part 3                      | `pnpm test:fault`                                       |
| Build              | PASS                                           | `pnpm build`, `pnpm build:workers`                      |
| Baseline E2E       | PASS, 20 tests at 360/768/1200                 | `pnpm test:e2e`                                         |
| License / SBOM     | PASS; 3 release blockers remain non-CI         | `pnpm license:check`, `pnpm sbom:generate`              |
| Compose config     | PASS with and without `aiproxy` profile        | `docker compose ... config`                             |

## Test IDs

| Test ID                | Phase 1 status                                             | Evidence file                                              |
| ---------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| `TEST-X-COMPOSE-READY` | Static contract PASS; live AIProxy smoke not run           | `test/contract/s5-compose-config.test.ts`                  |
| `TEST-MODEL-001-BLOCK` | PASS                                                       | `s5-model-catalog.test.ts`                                 |
| `TEST-MODEL-002-BLOCK` | PASS                                                       | `s5-model-gateway.test.ts`                                 |
| `TEST-MODEL-003-BLOCK` | PASS                                                       | `s5-model-gateway.test.ts`, `s5-model-parse-fault.test.ts` |
| `TEST-MODEL-004-BLOCK` | PASS                                                       | `s5-processing.test.ts`, `s5-qa-pipeline.test.ts`          |
| `TEST-MODEL-005-BLOCK` | PASS                                                       | mock catalog covers STT/TTS; audio objects remain excluded |
| `TEST-MODEL-006-BLOCK` | PASS                                                       | auth/retry/fallback fault tests                            |
| `TEST-KB-002-BLOCK`    | PASS                                                       | `s5-model-binding.test.ts`, concurrency/tenant tests       |
| `TEST-PARSE-001-BLOCK` | PASS                                                       | ten-format matrix, LiteParse and artifact tests            |
| `TEST-PARSE-002-BLOCK` | PASS, external providers mocked                            | OCR provider, asset and fault tests                        |
| `TEST-PARSE-003-BLOCK` | PASS                                                       | chunk settings tests                                       |
| `TEST-PARSE-004-BLOCK` | PASS                                                       | QA validation/repair/dedup tests                           |
| `ACC-UI-01...07`       | Phase 1 state/component tests PASS; S5 E2E pending phase 2 | `s5-model-parse-ui.test.ts`                                |

## Remaining Work

- Rebase only after the user confirms S4 merge and supplies its merge SHA.
- Apply the second user-run `pnpm install`, regenerate OpenAPI, promote exactly
  the four S5 operations, and run W1 integration.
- Freeze `candidateSha`, then collect independent personA/personB evidence.
- Real external LLM/VLM/STT/TTS and OCR verification remains
  `EXTERNAL_UNVERIFIED`.

## Phase 1 Boundary

- The four S5 operations remain deferred and are not reachable through public
  runtime.
- No S5 page, navigation entry, barrel export, public API client change, worker
  consumer, child Job, Segment write, search write, or index write was added.
- `pnpm-lock.yaml` is generated by the user's first install and remains
  provisional until the second install after rebase.
- `pnpm sbom:generate` refreshed `NOTICE`; OpenAPI generated artifacts were not
  changed.

## Residual Risks

- Live AIProxy Compose health and `/v1/models` remain phase 2 work.
- OCR, external LLM, VLM, STT, and TTS credentials are unavailable and remain
  `EXTERNAL_UNVERIFIED`.
- The license gate passes but still reports three pre-existing
  `pending-legal-review` release blockers: `caniuse-lite`, `pako`, and `sax`.
