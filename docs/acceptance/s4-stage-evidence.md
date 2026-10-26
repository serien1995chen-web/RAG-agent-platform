# S4 Stage Evidence

Status: `S4_BRANCH_EVIDENCE_DRAFT`

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

Inputs:

| Input                | SHA-256                                                            |
| -------------------- | ------------------------------------------------------------------ |
| S4 Plan              | `cc7d6aa12de5ed4f86d92c6834980d9d41be5c823028bf62cda438851b4fc14a` |
| System design        | `8e5e7300c651c4fe0478b87fc3572add52f95c3e49c8f15700b45bb8c690a26d` |
| Stage task breakdown | `11aa3693599759ef969c9f6ad85ae61da8fd925940baacfb17a1c5c389e2fb6e` |

## Task And Capability Coverage

| Task     | Capability                          | Status                                | Evidence                                                |
| -------- | ----------------------------------- | ------------------------------------- | ------------------------------------------------------- |
| `S4-T01` | C1 / `ING-001...009`                | PASS                                  | Transaction integration and concurrency tests           |
| `S4-T02` | `ING-001`, `ING-002`                | PASS                                  | Text E2E, upload binding and content tests              |
| `S4-T03` | `ING-003`                           | PASS                                  | SSRF/redirect fault tests and URL import integration    |
| `S4-T04` | `ING-004`, `ING-005`                | PASS                                  | CSV/XLSX parser tests and backup dry-run integration    |
| `S4-T05` | `ING-006`, `API-002`                | PASS                                  | API library contract/provider tests                     |
| `S4-T06` | `ING-007...009`, `OPS-005` sub-item | PASS                                  | Connector encryption, CAS, sync submit and delete tests |
| `S4-T07` | `DOWN-004` S4 subset                | PASS / `IMPLEMENTED_S4_SUBSET / DATA` | Scoped auth and external write tests                    |
| `S4-T08` | S4 UI                               | PASS                                  | Import/Connectors three-viewport screenshots and axe    |
| `S4-T09` | Full S4 regression                  | PASS                                  | S4 branch gate                                          |

Capability counts remain:

```text
total=73 BASE=12 DATA=57 EXCLUDED=4
```

`DOWN-004` remains `DATA`; S10 owns real API Key closure.

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

No S5 operation is registered by this branch.

## C1 / C2 / C6

### C1

- Source, one parent import Job, Audit and Outbox are written in one Mongo
  transaction.
- Batch imports create one parent Job and N Sources.
- Same key/body replays the original Job and Source IDs; different body returns 409.
- Outbox is `knowledge-import`, `status=pending`.
- No BullMQ enqueue occurs in S4.
- No parse child Job or Segment is created.

### C2

- S4 creates ObjectRef, Source, configuration snapshots and parent Job only.
- Text import stores source raw content, not S5 parsed `rawText`.
- No parse, chunk, QA, embedding or index work is executed.

### C6

- Files/text external writes require `knowledge:write`, a valid workspace and
  Space ACL.
- The `ScopedAuthPort` and fixture subject are S4-only extension points.
- Real API Key lifecycle remains deferred to S10.

## Atomic Steps

| Plan step          | Result                                                                      |
| ------------------ | --------------------------------------------------------------------------- |
| `S4-T01-S01`       | Catalog/manifests/ledger updated to 24 dependencies and 131 catalog entries |
| `S4-T01-S02`       | User `pnpm install`; lock SHA changed from `13eb464...` to `38505cc...`     |
| `S4-T01-S03`       | Ingestion DTO, Port and validators implemented                              |
| `S4-T01-S04`       | C1 transaction and runtime ingestion dispatch implemented                   |
| `S4-T01-S05`       | Idempotency, concurrency and outbox fault tests added                       |
| `S4-T02-S01...S03` | Upload binding, text snapshot and E2E added                                 |
| `S4-T03-S01...S03` | SSRF, pinned URL request, redirect and size controls added                  |
| `S4-T04-S01...S04` | CSV/XLSX parser, diagnostics, dry-run and restore strategies added          |
| `S4-T05-S01...S04` | Custom API catalog/content adapters and error mapping added                 |
| `S4-T06-S01...S05` | AES-GCM credentials, connector CAS, providers, sync/delete added            |
| `S4-T07-S01...S03` | Scoped fixture auth and files/text external writes added                    |
| `S4-T08-S01...S04` | Import workbench and Connectors settings UI added                           |
| `S4-T09-S01...S05` | Full S4 gates and evidence added                                            |

## Test Evidence

| Command                             | Result                           |
| ----------------------------------- | -------------------------------- |
| `pnpm lint`                         | PASS                             |
| `pnpm format:check`                 | PASS                             |
| `pnpm typecheck`                    | PASS, 12/12 packages             |
| `pnpm architecture:check`           | PASS                             |
| `pnpm forbidden-files:check`        | PASS                             |
| `pnpm license:check`                | PASS, 5 release blockers         |
| `pnpm test:unit`                    | PASS, 20/20 tasks                |
| `pnpm test:contract`                | PASS, 9 files / 48 tests         |
| `pnpm test:integration`             | PASS, service 8 files / 65 tests |
| `pnpm test:tenant`                  | PASS, 3 files / 10 tests         |
| `pnpm test:concurrency`             | PASS, 4 files / 10 tests         |
| `pnpm test:fault`                   | PASS, 4 files / 18 tests         |
| `pnpm test:e2e`                     | PASS, S1-S4 suites, 24 tests     |
| `pnpm build`                        | PASS                             |
| `pnpm build:workers`                | PASS                             |
| `docker compose ... config --quiet` | PASS                             |

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

The E2E gate checks horizontal overflow, serious/critical axe findings and
console errors at 360, 768 and 1200 pixels.

## Side Effects And Boundaries

- Mongo: `knowledge_sources`, `knowledge_jobs`, `knowledge_audit_events`,
  `knowledge_outbox_events`, `knowledge_object_refs`,
  `knowledge_connectors`, `knowledge_connector_cursors`.
- Object storage: canonical source ObjectRefs only; no parser output.
- Queue: Outbox pending only; no direct enqueue and no S4 worker.
- Provider: Feishu, Yuque, DingTalk and custom API are mock/provider-contract
  evidence only.
- Real external provider status: `EXTERNAL_UNVERIFIED`.

## Open Risks

- Real external provider credentials are unavailable; provider verification
  remains `EXTERNAL_UNVERIFIED`.
- Outbox delivery and consumer execution are S6 scope.
- S4 branch pass is not W1 pass.
- W1 83/37 remains unproven until S5 merges and personB reruns the candidate SHA.
- `DOWN-004` remains `DATA` until S10 real API Key closure.
- Five pending legal-review release blockers remain release-blocking.
