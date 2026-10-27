# S5 Model and Parse Stage Evidence

## Status

- Wave / stage / owner: W1 / S5 / personA.
- Parallel stage: S4 / personB.
- Branch: `feat/kb-s05-model-parse`.
- W1 baseline: `4cf765b2d82496f74e92eb27327a2358c92fe928`.
- S4 personB merge SHA: `506ed2c07edcd02219d1824a5271e283a6022c2b`.
- Candidate SHA: `d20da2511b185f9274bd7520d4fb935d68593f44`.
- Evidence commit SHA: `SELF_DOCS_ONLY_COMMIT` (exact SHA recorded in the final
  delivery report).
- Phase 1: independent implementation and gates PASS.
- Phase 2: rebase, shared-file integration, runtime promotion and personA gate PASS.
- PersonB: independent W1 gate PASS on the same candidate.
- Wave W1: `PASS_PENDING_FINAL_CI_AND_REVIEW_BINDING`.

Evidence SHA-256:

- PersonA: `40fc15b6eb30d0790da0520f8e121248e3efdd12a6d6450db66fffd601d2d1f8`.
- PersonB: `66728066509ecc3a7a91ef7908e1f4d6f78c5825f046da41b27407beb622e841`.

This document records the S5 stage result at the frozen candidate. It does not
substitute for the independent personB gate. Both owner gates PASS; final CI and
Review/PR Review binding remain.

## Scope

- Tasks: S5-T01 through S5-T09.
- Capabilities: `KB-002`, `MODEL-001...006`, `PARSE-001...004`.
- Operations: `API-MODEL-LIST`, `API-MODEL-BINDING-GET`,
  `API-MODEL-BINDING-UPDATE`, `API-MODEL-BINDING-VALIDATE`.
- C2: parse/chunk/QA output is returned to the future S6 caller; S5 writes no
  Job, child Job, Segment, search record, or index record.
- C6: model and OCR attempts write idempotent usage facts plus pending
  `knowledge-outbox` records in Mongo transactions.
- Shared runtime, service/web barrels, query keys, i18n, New/Overview/Import pages
  and the contract allowlist contain the authorized S4/S5 union.
- Shared navigation, public HTTP client, legacy page routes and
  `knowledge-worker.ts` were not changed by S5.

## Candidate Gates

| Gate               | Result                                             | Evidence                                                |
| ------------------ | -------------------------------------------------- | ------------------------------------------------------- |
| Contract inventory | PASS, `92/120/139/8`, runtime `83/37`              | `openapi:check`, `knowledge:inventory`, `check-runtime` |
| Runtime union      | PASS, intersection `0`, union `120`, old pages `0` | `knowledge:check-runtime`                               |
| S4/S5 operations   | PASS, S4 `14` + S5 `4`                             | runtime registry and contract tests                     |
| Lint / format      | PASS                                               | `pnpm lint`, `pnpm format:check`                        |
| Typecheck          | PASS, 12 packages                                  | `pnpm typecheck`                                        |
| Architecture       | PASS, 88 service sources / 12 workspace packages   | `architecture:check`, `forbidden-files:check`           |
| Unit               | PASS, Turbo `21/21` tasks                          | `pnpm test:unit`                                        |
| Contract           | PASS, `75/75` tests                                | `pnpm test:contract`                                    |
| Integration        | PASS, Turbo `21/21`; service `97/97`               | `pnpm test:integration`                                 |
| Tenant             | PASS, `11/11` tests                                | `pnpm test:tenant`                                      |
| Concurrency        | PASS, `12/12` tests                                | `pnpm test:concurrency`                                 |
| Fault              | PASS, `24/24` tests                                | `pnpm test:fault`                                       |
| Build              | PASS, app and 12 packages                          | `pnpm build`, `pnpm build:workers`                      |
| E2E                | PASS, `34/34` tests at 360/768/1200                | `pnpm test:e2e`                                         |
| License / SBOM     | PASS; 5 pre-existing release blockers remain       | `pnpm license:check`, `pnpm sbom:generate`              |
| AIProxy Compose    | PASS; fixed images, healthy services, HTTP 200     | `docker compose`, `/api/status`, `/v1/models`           |

Detailed personA command exit codes, environment and log hashes are recorded in
`docs/acceptance/w1-personA-gate.md`.

## Test IDs

| Test ID                | Candidate status | Evidence file                                        |
| ---------------------- | ---------------- | ---------------------------------------------------- |
| `TEST-X-COMPOSE-READY` | PASS             | Compose contract plus live status/models probe       |
| `TEST-MODEL-001-BLOCK` | PASS             | `s5-model-catalog.test.ts`, S5 E2E                   |
| `TEST-MODEL-002-BLOCK` | PASS             | `s5-model-gateway.test.ts`                           |
| `TEST-MODEL-003-BLOCK` | PASS             | Gateway and usage/outbox tests                       |
| `TEST-MODEL-004-BLOCK` | PASS             | `s5-processing.test.ts`, `s5-qa-pipeline.test.ts`    |
| `TEST-MODEL-005-BLOCK` | PASS             | Mock catalog covers six types and 768/1024/1536/3072 |
| `TEST-MODEL-006-BLOCK` | PASS             | Auth/retry/fallback fault tests                      |
| `TEST-KB-002-BLOCK`    | PASS             | Binding, concurrency, tenant and S5 E2E              |
| `TEST-PARSE-001-BLOCK` | PASS             | Ten-format matrix, LiteParse and artifact tests      |
| `TEST-PARSE-002-BLOCK` | PASS             | OCR provider, asset and fault tests                  |
| `TEST-PARSE-003-BLOCK` | PASS             | Chunk settings and deterministic policy tests        |
| `TEST-PARSE-004-BLOCK` | PASS             | QA validation/repair/dedup/fallback tests            |
| `ACC-UI-01...07`       | PASS             | S5 UI state and three-viewport E2E                   |

## Integration Result

- `knowledge.application.ts` retains S4 handlers and adds S5 LIST/VALIDATE,
  binding GET and binding UPDATE dispatch.
- `knowledge-runtime.ts` retains S4 import/connector factories and adds AIProxy,
  OCR, usage, artifact and S5 processing composition.
- S5 parser controls are appended to the existing S4 Import page.
- S5 private settings are reduced to the frozen S4 public chunking fields before
  submission; the public settings schema is not expanded.
- Model bindings are available on New and Overview without removing S4 controls.
- S4 Import tests retain their assertions and use specific accessible locators
  where the S5 settings panel adds another textarea.

## Dependency And Generated Facts

- User install 1: Phase 1 dependencies; exit `0`.
- User install 2 after S4 rebase: S4/S5 lockfile union; exit `0`.
- User install 3: narrowly authorized `@kb/qa: workspace:*` link for
  `@kb/service`; exit `0`.
- Agent did not execute `pnpm install/add/update/remove`.
- Final lockfile is pnpm-generated and records the service-to-QA workspace link.
- PersonB used the complete read-only
  `w1-full-dependency-view-d20da251.tar.gz`, SHA-256
  `6aca2e41368388232a0242f94a3b6b24849e3efaeeb0567b3f3e969816172a8f`,
  without installing.
- Final OpenAPI union was produced only by `pnpm openapi:generate`.
- `pnpm openapi:check` and `git diff --check` pass after generation.

## Real / Mock / External

- Real verified: fixed AIProxy/PostgreSQL Compose images, health, `/api/status`,
  empty `/v1/models`, LiteParse package/fallback, Mongo transactions, Redis,
  PostgreSQL and MinIO.
- Mock pass: AIProxy HTTP contracts, model gateway, four OCR providers, QA
  repair/fallback and fault injection.
- External unverified: real LLM/embedding/rerank/VLM/STT/TTS and external OCR
  credentials. The empty model catalog is gateway evidence only.

## Remaining Work

- A and B evidence must be committed together as one evidence-only commit under
  `docs/acceptance/**`.
- CI must run at the final evidence commit; Review/PR Review binds the CI URL.
- External provider verification remains `EXTERNAL_UNVERIFIED`.

## Boundary

- No `parseVersion`, AIProxy SDK, OCR SDK, Segment/index write, S6 child Job or
  S10 usage/admin UI was added.
- `knowledge-worker.ts` and public route registry were not changed.
- S4 handlers, schemas, UI, tests, dependencies and generated changes are
  retained.
- `DOWN-004` remains `DATA`; S11 was not implemented or modified.
