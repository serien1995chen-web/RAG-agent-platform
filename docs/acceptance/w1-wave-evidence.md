# W1 Wave Evidence

## Status

- Wave: `W1`.
- Parallel stage: `S4 / personB` with `S5 / personA`.
- PersonA gate: `PASS`.
- PersonB gate: `PASS`.
- Candidate SHA: `d20da2511b185f9274bd7520d4fb935d68593f44`.
- W1 base SHA: `4cf765b2d82496f74e92eb27327a2358c92fe928`.
- S4 merge SHA: `506ed2c07edcd02219d1824a5271e283a6022c2b`.
- Candidate branch: `feat/kb-s05-model-parse`.
- Candidate remote head: equals the candidate SHA.
- Candidate lockfile SHA-256:
  `3b0cea949ba6285d572aa0541fe83c1d91fcbb98eac5dc25eae24dfdd438ba13`.
- Evidence commit SHA: `SELF_DOCS_ONLY_COMMIT` (exact SHA recorded in the final
  delivery report).
- CI run URL: `PENDING_REVIEW_PR_BINDING`.
- Review/PR Review binding: `PENDING`.

Both independent owner gates ran against the same candidate. The candidate
contains product code, tests, lockfile and generated artifacts only. All evidence
files and screenshots are added afterward in one docs-only commit.

## Owner Gates

| Owner   | Worktree                                      | Gate | Evidence                             |
| ------- | --------------------------------------------- | ---- | ------------------------------------ |
| personA | `/home/serien/RAG-agent-platform`             | PASS | `docs/acceptance/w1-personA-gate.md` |
| personB | `/home/archer/RAG-agent-platform-w1-d20da251` | PASS | `docs/acceptance/w1-personB-gate.md` |

PersonA:

- Worktree clean at gate start.
- S4 merge confirmed as an ancestor.
- Full lint, format, typecheck, architecture, forbidden-files, contract,
  integration, tenant, concurrency, fault, build, worker build, E2E, license,
  SBOM, Compose and AIProxy smoke gates exited `0`.
- PersonA evidence SHA-256:
  `8a30dc7d850b782ed79cce1cb3b38e9018ac8da852ff288a2c53efcdd1dca849`.

PersonB:

- Independent detached checkout at the candidate SHA.
- Tracked worktree clean before and after the gate.
- 32 recorded commands, all with exit code `0`.
- Complete read-only dependency view consumed without `pnpm install`.
- PersonB evidence SHA-256:
  `62f7175c3bb7e2fd52bbc4074dc8dfec2ce1e6e8c6dfe4f2fd3014c9a81a4464`.

## Contract And Runtime

| Check                                  | Result                                                   |
| -------------------------------------- | -------------------------------------------------------- |
| Contract                               | `92 paths / 120 operations / 139 schemas / 8 parameters` |
| Runtime / deferred                     | `83 / 37`                                                |
| Runtime/deferred intersection          | `0`                                                      |
| Runtime/deferred union                 | `120`                                                    |
| Old page routes                        | `0`                                                      |
| S4 runtime operations                  | `14 / 14` present                                        |
| S5 runtime operations                  | `4 / 4` present                                          |
| S6 or later operation promotion        | none                                                     |
| Candidate unique `TEST-*` IDs          | `130`                                                    |
| S4 merge unique `TEST-*` IDs preserved | `116 / 116`                                              |

S4 runtime operations:

```text
API-IMPORT-FILES
API-IMPORT-TEXT
API-IMPORT-URL
API-IMPORT-TEMPLATE
API-IMPORT-BACKUP
API-IMPORT-API-CATALOG
API-IMPORT-API-LIBRARY
API-CONNECTOR-CONNECT
API-CONNECTOR-CATALOG
API-CONNECTOR-IMPORT
API-CONNECTOR-SYNC
API-CONNECTOR-UPDATE
API-CONNECTOR-GET
API-CONNECTOR-DELETE
```

S5 runtime operations:

```text
API-MODEL-LIST
API-MODEL-BINDING-GET
API-MODEL-BINDING-UPDATE
API-MODEL-BINDING-VALIDATE
```

## Command Matrix

| Gate                                | PersonA                             | PersonB                           |
| ----------------------------------- | ----------------------------------- | --------------------------------- |
| Lint / format                       | PASS                                | PASS                              |
| Typecheck                           | PASS, 12/12 packages                | PASS, 12/12 packages              |
| Architecture / forbidden files      | PASS                                | PASS                              |
| OpenAPI / inventory / runtime union | PASS                                | PASS                              |
| Unit                                | PASS, Turbo 21/21 tasks             | PASS, 212 tests                   |
| Contract                            | PASS, 75 tests                      | PASS, 75 tests                    |
| Integration                         | PASS, Turbo 21/21; service 97 tests | PASS, service 97 tests            |
| Tenant                              | PASS, 11 tests                      | PASS, 11 tests                    |
| Concurrency                         | PASS, 12 tests                      | PASS, 12 tests                    |
| Fault                               | PASS, 24 tests                      | PASS, 24 tests                    |
| Build                               | PASS, 12/12 tasks                   | PASS, 12/12 tasks                 |
| Worker build                        | PASS, 10/10 tasks                   | PASS, 10/10 tasks                 |
| E2E                                 | PASS, 34 tests                      | PASS, 34 tests                    |
| License / SBOM                      | PASS                                | PASS                              |
| Compose config                      | PASS, default and AIProxy profile   | PASS, default and AIProxy profile |
| AIProxy smoke                       | PASS, status and models HTTP 200    | PASS, status and models HTTP 200  |
| Final tracked worktree              | clean at candidate                  | clean at candidate                |

PersonB used the complete read-only dependency view:

```text
w1-full-dependency-view-d20da251.tar.gz
bytes=293944590
sha256=6aca2e41368388232a0242f94a3b6b24849e3efaeeb0567b3f3e969816172a8f
```

The view supplied the root `node_modules`, `.pnpm` virtual store,
`.modules.yaml`, lock index, all workspace dependency layouts,
`projects/app/node_modules`, and both S5 packages. PersonB did not install.

## Capability

- Canonical inventory: `73 total / 12 BASE / 57 DATA / 4 EXCLUDED`.
- Accepted baseline capabilities: `6`.
- W1 candidate capabilities: `22`.
- Implemented after W1: `28`.
- Closed after W1: `27`.
- W1 open capability: `DOWN-004`.
- `DOWN-004` remains `DATA`; S10 owns real API Key closure.

S4 capabilities:

- `ING-001...009`, `API-002`, the `DOWN-004` S4 subset, and the `OPS-005`
  connector subset passed their blocking test families.
- S4 handlers, schemas, UI, tests, dependencies and generated changes remain.

S5 capabilities:

- `KB-002`.
- `MODEL-001...006`.
- `PARSE-001...004`.

Blocking test families:

- `TEST-MODEL-001...006-BLOCK`.
- `TEST-KB-002-BLOCK`.
- `TEST-PARSE-001...004-BLOCK`.
- `TEST-X-COMPOSE-READY`.
- `TEST-X-OCR-TIMEOUT`.
- `TEST-X-PROVIDER-CONTRACT`.
- `TEST-X-SECRET-LEAK`.
- `TEST-X-FRONTEND-IMPORT`.
- `ACC-UI-01...07`.

## C1 / C2 / C6

- C1 S4 commit side: Source drafts, one parent import Job with N Sources, Audit,
  and pending Outbox are covered by integration, concurrency and fault tests.
- C2 S5 parse/chunk/QA: parser formats, LiteParse fallback, OCR contracts,
  artifact persistence, deterministic chunking and QA repair/dedup/fallback
  pass. S5 does not write Segment, Job, search or index records.
- C6 S5 usage/audit: model and OCR attempts produce idempotent usage facts and
  pending `knowledge-outbox` events in Mongo transactions.
- S5 does not implement S10 quota, admin, cleanup, replay or usage UI.

## Dependencies And Generated Artifacts

- User install 1: Phase 1 dependencies; user-reported exit `0`.
- User install 2: S4/S5 lockfile union after rebase; user-reported exit `0`.
- User install 3: explicitly authorized `@kb/qa: workspace:*` service link;
  user-reported exit `0`.
- The Coding Agent did not execute `pnpm install/add/update/remove`.
- The final candidate lockfile is pnpm-generated and has SHA
  `3b0cea949ba6285d572aa0541fe83c1d91fcbb98eac5dc25eae24dfdd438ba13`.
- OpenAPI union was generated only by `pnpm openapi:generate`.
- `pnpm openapi:check` passes at `92/120/139/8`, runtime `83/37`.
- License gate: 12 workspace packages, 132 catalog entries, 684 production
  components.
- SBOM: direct `132`, transitive `1,398`, workspace `12`, image `4`.
- Five pre-existing `pending-legal-review` release blockers remain:
  `argparse`, `caniuse-lite`, `jschardet`, `pako`, and `sax`. They block release,
  not this CI gate.

## Real / Mock / External

### Real verified

- AIProxy `v0.7.3` and its independent PostgreSQL start from fixed local images.
- AIProxy health and `/api/status` return HTTP 200.
- `/v1/models` returns HTTP 200 with an empty list.
- LiteParse `2.0.8` package and PDF.js load-error fallback.
- Local Mongo replica-set transactions, Redis, PostgreSQL/pgvector and MinIO.

The empty model catalog proves gateway reachability only. It does not prove an
upstream model is usable.

### Mock pass

- AIProxy catalog and model HTTP contracts.
- Four OCR provider HTTP contracts.
- QA generation, repair, deduplication and fallback fixtures.
- Auth, retry, timeout, tenant, concurrency and fault injection.

### External unverified

- Real LLM, embedding, rerank, VLM, STT and TTS providers.
- Sangfor, Somark, Textin and Doc2x external OCR credentials.
- Feishu, Yuque, DingTalk and custom API external integrations.
- Durable provider-side billing, quota and administrative behavior outside S5.

No mock result is labeled `REAL_VERIFIED`.

## UI Evidence

The S5 E2E checks `360 / 768 / 1200` viewports, horizontal overflow and
serious/critical axe findings. It also verifies the retained S4 Import and the
S5 parser/chunk/QA settings.

| Screenshot                                      | SHA-256                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `docs/acceptance/s5-ui/s5-model-parse-360.png`  | `500a1507bc675d756f9ba742ef444bc1de4e774149cc18b19c8918bcb90a95f2` |
| `docs/acceptance/s5-ui/s5-model-parse-768.png`  | `6cb5b84922623b074e2327421a38a8ec973ac684423d2004b6b0fd50bef9a185` |
| `docs/acceptance/s5-ui/s5-model-parse-1200.png` | `712a8fdf3c5b4220c244b514bf08b860367b09ef4d16302e9b1cecabdd13ef3f` |

## Evidence Hashes

```text
pnpm-lock.yaml
3b0cea949ba6285d572aa0541fe83c1d91fcbb98eac5dc25eae24dfdd438ba13

personB gate
62f7175c3bb7e2fd52bbc4074dc8dfec2ce1e6e8c6dfe4f2fd3014c9a81a4464

personA gate
8a30dc7d850b782ed79cce1cb3b38e9018ac8da852ff288a2c53efcdd1dca849

full dependency view
6aca2e41368388232a0242f94a3b6b24849e3efaeeb0567b3f3e969816172a8f

runtime-registry.data.json
54837c89f2a0fb3fb0408c1e773ff2ee8ec07acb7f69f5226adb6b24e807f875

deferred-manifest.data.json
d830bfb742d65fbdfc1cecdd30fdd68465a0ed2aaa6973031fcde0c16a508802

knowledge-target.openapi.json
038a91ccb0e54515e00ebd6e06cc7e84df01dd6c96debf2721bc35a973046c8e

S5 fixture manifest
3b595682e3997b9bef549e5976633c32e13730f992f84f9fc2a24e436720b325
```

## Risks

- CI must run at the final docs-only evidence commit; its URL is intentionally
  bound by the Review/PR Review report.
- External model, VLM, STT, TTS, OCR and connector verification remains
  `EXTERNAL_UNVERIFIED`.
- Five legal-review release blockers remain release-blocking.
- `DOWN-004` remains `DATA`; S10 owns real API Key closure.
- S11 is unrelated and was not implemented or modified.

## Evidence Boundary

- Product files, lockfile and generated artifacts are frozen at candidate
  `d20da2511b185f9274bd7520d4fb935d68593f44`.
- The evidence commit changes only `docs/acceptance/**`.
- Any later code, lockfile, rebase or reinstall change invalidates both owner
  gates and requires a new candidate and repeated personA/personB gates.
