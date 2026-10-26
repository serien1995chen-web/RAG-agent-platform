# S4 Stage Evidence

Status: `S4_BRANCH_EVIDENCE_DRAFT / REVIEW_FIXES_READY`

## Baseline

| Field            | Value                                      |
| ---------------- | ------------------------------------------ |
| Wave             | W1                                         |
| Stage            | S4                                         |
| Owner            | personB                                    |
| Parallel stage   | S5 / personA                               |
| Branch           | `feat/kb-s04-ingestion-connectors`         |
| Base branch      | `main`                                     |
| Base SHA         | `4cf765b2d82496f74e92eb27327a2358c92fe928` |
| S4 merge SHA     | not applicable                             |
| W1 candidate SHA | not supplied                               |
| W1 personB gate  | not run                                    |
| Review fixes     | S4 branch gate PASS                        |

Inputs:

| Input                | SHA-256                                                            |
| -------------------- | ------------------------------------------------------------------ |
| S4 Plan              | `cc7d6aa12de5ed4f86d92c6834980d9d41be5c823028bf62cda438851b4fc14a` |
| System design        | `8e5e7300c651c4fe0478b87fc3572add52f95c3e49c8f15700b45bb8c690a26d` |
| Stage task breakdown | `11aa3693599759ef969c9f6ad85ae61da8fd925940baacfb17a1c5c389e2fb6e` |

## Review Fix Matrix

| Review ID   | Result | Evidence                                                                       |
| ----------- | ------ | ------------------------------------------------------------------------------ |
| `S4-REV-01` | FIXED  | Dynamic imports preflight final truth; replay and later failures compensate    |
| `S4-REV-02` | FIXED  | Custom API uses pinned IP lookup, manual redirects, deadline and byte limit    |
| `S4-REV-03` | FIXED  | API catalog checks target Space write ACL before provider/credential access    |
| `S4-REV-04` | FIXED  | Connector sync keys include header Idempotency-Key and compare request hash    |
| `S4-REV-05` | FIXED  | Feishu/Yuque/DingTalk fixtures cover pagination, IDs, refresh and errors       |
| `S4-REV-06` | FIXED  | QuotaGate runs before ObjectStore/provider work and preserves zero facts       |
| `S4-REV-07` | FIXED  | Plan test IDs are implemented; this document records actual command results    |
| `S4-REV-08` | FIXED  | Overwrite uses explicit source-version CAS and records actual Job versions     |
| `S4-REV-09` | FIXED  | Fixed methods, none/cursor/offset modes and empty-content rejection are tested |
| `S4-REV-10` | FIXED  | Connector update validates credentials/config provider at both layers          |
| `S4-REV-11` | FIXED  | Connector UI provider follows `kind`; URL provider initializes the form        |
| `S4-REV-12` | FIXED  | S4 runtime capabilities are exact and contain no S5 parser capability          |
| `S4-REV-13` | FIXED  | CSV markers reject `= + - @`, leading whitespace/tabs; safe negative retained  |

## Task And Capability Coverage

| Task     | Capability                        | Status                                | Evidence                                                                                      |
| -------- | --------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `S4-T01` | C1 / `ING-001...009`              | PASS                                  | `TEST-ING-001-BLOCK`, `TEST-X-S4-IDEMPOTENCY`, `TEST-X-S4-COMMIT-FAULT`, `TEST-X-S4-NO-QUEUE` |
| `S4-T02` | `ING-001`, `ING-002`              | PASS                                  | `TEST-ING-001/002-BLOCK`, uploadRef, text replay and E2E                                      |
| `S4-T03` | `ING-003`                         | PASS                                  | `TEST-ING-003-BLOCK`, U01...U05, `TEST-X-SECURITY-URL`                                        |
| `S4-T04` | `ING-004`, `ING-005`              | PASS                                  | `TEST-ING-004/005-*`, dry-run, overwrite CAS and row diagnostics                              |
| `S4-T05` | `ING-006`, `API-002`              | PASS                                  | `TEST-ING-006-*`, `TEST-API-002-BLOCK`, `TEST-X-SECRET-LEAK`                                  |
| `S4-T06` | `ING-007...009`, `OPS-005` subset | PASS                                  | provider IDs, token/delete/CAS/sync idempotency                                               |
| `S4-T07` | `DOWN-004` S4 subset              | PASS / `IMPLEMENTED_S4_SUBSET / DATA` | `TEST-DOWN-004-*`, QuotaGate, scoped auth                                                     |
| `S4-T08` | S4 UI                             | PASS                                  | `ACC-UI-01...07`, 4 E2E files / 30 tests, axe and viewports                                   |
| `S4-T09` | Full S4 regression                | PASS                                  | all stage commands below, S4 branch only                                                      |

Capability counts remain:

```text
total=73 BASE=12 DATA=57 EXCLUDED=4
```

The authorized `scripts/knowledge-inventory.mjs` stage rule permits only
`PARSE-001...005` to remain unbound while S5 is absent. They are not mapped to
any S4 runtime operation. `DOWN-004` remains `DATA`; S10 owns real API Key
closure.

## Operation Coverage

All 14 S4 operations are runtime:

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

Runtime capabilities are asserted exactly. No S5 operation or parser
capability is registered on these operations.

## C1 / C2 / C6

### C1

- Source, one parent import Job, Audit and Outbox are written in one Mongo transaction.
- Batch imports create one parent Job and N Sources.
- Preflight prevents duplicate ObjectStore/provider calls on replay.
- Concurrent replay compensates objects created by the losing request.
- Same key/body replays the original Job and Source IDs; different body returns 409.
- Outbox is pending and Fake QueuePort `enqueue` count is zero.
- No parse child Job or Segment is created.

### C2

- S4 creates ObjectRef, Source, configuration snapshots and parent Job only.
- Text import stores source raw content, not S5 parsed `rawText`.
- URL/custom API requests use validated, pinned network targets and bounded responses.
- No parse, chunk, QA, embedding or index work is executed.

### C6

- Files/text and all dynamic import entries require workspace, scope and Space ACL.
- API catalog checks Space write ACL before provider or credential use.
- Connector update validates provider identity before credential encryption.
- The `ScopedAuthPort` and QuotaGate fixture are S4-only extension points.
- Real API Key lifecycle remains deferred to S10.

## Test ID Summary

Core IDs are locatable in:

| Area                      | Files                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| File/text/import C1       | `packages/service/test/integration/knowledge-import.test.ts`                                           |
| URL security              | `test/fault/knowledge-import-fault.test.ts`, `test/contract/knowledge-api-library.test.ts`             |
| Template/backup           | `packages/parse/test/unit/import-template.test.ts`, import integration                                 |
| API library               | `test/contract/knowledge-api-library.test.ts`                                                          |
| Cloud providers           | `test/contract/knowledge-s4-providers.test.ts`                                                         |
| Connector CAS/sync/delete | `packages/service/test/integration/knowledge-connector.test.ts`                                        |
| Tenant/idempotency        | `test/tenant/knowledge-import-tenant.test.ts`, `test/concurrency/knowledge-import-idempotency.test.ts` |
| UI                        | `test/e2e/knowledge-import.test.ts`, `test/e2e/knowledge-connector.test.ts`                            |

## Test Evidence

| Command                             | Result                                |
| ----------------------------------- | ------------------------------------- |
| `pnpm lint`                         | PASS                                  |
| `pnpm format:check`                 | PASS                                  |
| `pnpm typecheck`                    | PASS, 12/12 packages                  |
| `pnpm architecture:check`           | PASS, 64 service files / 12 packages  |
| `pnpm forbidden-files:check`        | PASS, 327 files scanned               |
| `pnpm license:check`                | PASS, 5 pending legal-review blockers |
| `pnpm test:unit`                    | PASS, 20/20 tasks                     |
| `pnpm test:contract`                | PASS, 11 files / 61 tests             |
| `pnpm test:integration`             | PASS, service 8 files / 79 tests      |
| `pnpm test:tenant`                  | PASS, 3 files / 10 tests              |
| `pnpm test:concurrency`             | PASS, 4 files / 10 tests              |
| `pnpm test:fault`                   | PASS, 4 files / 21 tests              |
| `pnpm test:e2e`                     | PASS, 4 files / 30 tests              |
| `pnpm build`                        | PASS                                  |
| `pnpm build:workers`                | PASS                                  |
| `pnpm openapi:check`                | PASS                                  |
| `pnpm knowledge:inventory`          | PASS                                  |
| `pnpm knowledge:check-runtime`      | PASS                                  |
| `docker compose ... config --quiet` | PASS                                  |

Contract/runtime:

```text
paths=92
operations=120
schemas=139
parameters=8
runtime=79
deferred=41
runtime/deferred intersection=0
union=120
old page route=0
Mongo collections=23
vector profiles=4
queues=13
```

## UI Evidence

Ignored screenshot outputs are under:

```text
test-results/s4-ui/import-360.png
test-results/s4-ui/import-768.png
test-results/s4-ui/import-1200.png
test-results/s4-ui/connectors-360.png
test-results/s4-ui/connectors-768.png
test-results/s4-ui/connectors-1200.png
```

The E2E gate checks 360/768/1200 layout, horizontal overflow, serious/critical
axe findings and console errors. S4 interaction coverage includes text submit,
URL SSRF Problem, template rowNumber, API catalog network capture, conflict
retry, connector provider initialization and connect/update/sync/delete.

## Side Effects And Boundaries

- Mongo: `knowledge_sources`, `knowledge_jobs`, `knowledge_audit_events`,
  `knowledge_outbox_events`, `knowledge_object_refs`,
  `knowledge_connectors`, `knowledge_connector_cursors`.
- Object storage: canonical source ObjectRefs only; replay/failure compensation removes new keys.
- Queue: Outbox pending only; no direct enqueue and no S4 worker.
- Provider: Feishu, Yuque, DingTalk and custom API are deterministic contract fixtures.
- Real external provider status: `EXTERNAL_UNVERIFIED`.

## Open Risks

- Real external provider credentials are unavailable; provider verification remains `EXTERNAL_UNVERIFIED`.
- Outbox delivery and consumer execution are S6 scope.
- The S4 branch pass is not a W1 pass.
- W1 83/37 remains unproven until S5 merges and personB reruns the candidate SHA.
- `DOWN-004` remains `DATA` until S10 real API Key closure.
- Five pending legal-review release blockers remain release-blocking.
- No push, PR, merge or W1 personB gate has been performed.
