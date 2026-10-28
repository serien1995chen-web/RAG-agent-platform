# S8 Provider Matrix

## Scope

| Field                    | Value                                                  |
| ------------------------ | ------------------------------------------------------ |
| Wave / stage / owner     | `W3 / S8 / personB`                                    |
| Base                     | `origin/main@13fa0e9be84edd33ea5cc5413d64282c126dd117` |
| Implementation candidate | `9ed48366872bfa35271a4d3ce77f1ef84de06eec`             |
| Branch                   | `feat/kb-s08-image-deep-rag`                           |
| Worktree                 | `/home/archer/RAG-agent-platform-w3-s8-personB`        |

## Real Verified

| Component             | Evidence                                                                        | Tests                                                                                           |
| --------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| MongoDB replica set   | Real image Source/ObjectRef/Segment writes, CAS, round audit and cleanup        | `TEST-MULTI-001-BLOCK`, `TEST-X-IMAGE-CAPTION`, `TEST-TRAIN-003-BLOCK`, `TEST-SEARCH-008-BLOCK` |
| Redis / BullMQ        | Real queue delivery and retry/fencing paths remain active                       | `TEST-TRAIN-001-BLOCK`, `TEST-TRAIN-003-BLOCK`                                                  |
| PostgreSQL / pgvector | Real `image`, `image_caption` vectors and candidate recall                      | `TEST-SEARCH-006-BLOCK`, `TEST-TRAIN-003-BLOCK`                                                 |
| MinIO / ObjectRef     | Active image ObjectRef and controlled file ticket path                          | `TEST-MULTI-001-BLOCK`, `TEST-SEARCH-006-BLOCK`                                                 |
| Canonical HTTP app    | Real catch-all route, `API-SEARCH-IMAGE`, `API-SEARCH-DEEP`, `API-FILE-PREVIEW` | `s8-image-deep-page.test.ts`                                                                    |
| Browser UI            | Real Chromium at 360/768/1200 with axe, overflow, console and network checks    | `TEST-X-FRONTEND-A11Y`                                                                          |

The Redis, PostgreSQL and MinIO services were healthy locally. Mongo uses
`directConnection=true` because the local replica-set member advertises the
Compose hostname `mongo:27017`; the probe confirmed `setName=rs0`, writable
primary state and a committed transaction.

## Fixture Verified

| Capability         | Fixture                                                                              | State              |
| ------------------ | ------------------------------------------------------------------------------------ | ------------------ |
| VLM caption        | Deterministic `mock-vlm` JSON caption                                                | `FIXTURE_VERIFIED` |
| Vision embedding   | Deterministic ordered `text` + `image_url` vectors                                   | `FIXTURE_VERIFIED` |
| Deep planner       | Deterministic JSON query/sufficiency output                                          | `FIXTURE_VERIFIED` |
| Deep stop behavior | `sufficient`, `round_limit`, `token_budget`, `no_new_evidence`, `dependency_failure` | `FIXTURE_VERIFIED` |
| Provider faults    | 429, timeout, invalid output and partial evidence                                    | `FIXTURE_VERIFIED` |

## External Unverified

| External dependency         | State                 | Reason                                                       |
| --------------------------- | --------------------- | ------------------------------------------------------------ |
| Production AIProxy VLM      | `EXTERNAL_UNVERIFIED` | No production credential or vendor endpoint supplied         |
| Production vision embedding | `EXTERNAL_UNVERIFIED` | No production credential or model capability record supplied |
| Production rerank           | `EXTERNAL_UNVERIFIED` | No production rerank credential supplied                     |
| Vendor vision capability    | `EXTERNAL_UNVERIFIED` | Must be confirmed against the selected vendor contract       |
| IAM / API-key scope         | `EXTERNAL_UNVERIFIED` | Scheduled for S10                                            |

## Boundary

- Mock/provider fixture success is not reported as a real Provider result.
- The local app and infrastructure path is `REAL_VERIFIED`.
- No S9 synonym runtime, page, navigation, i18n or handler is included.
- This matrix does not declare W3 complete.
