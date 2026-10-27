# S4 Provider Matrix

Status: `EXTERNAL_UNVERIFIED`

All cloud/custom providers below are deterministic contract fixtures. No mock
result is represented as real provider verification.

| Provider        | S4 Implementation                                      | Test IDs                                                                   | Fixture location                                                                                                | Real verification            |
| --------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| File upload     | S2 ObjectRef binding                                   | `TEST-ING-001-BLOCK`, `TEST-X-SECURITY-UPLOAD`                             | `packages/service/test/integration/knowledge-import.test.ts`; `packages/parse/test/unit/archive-safety.test.ts` | Local MinIO only             |
| Text            | Source ObjectRef snapshot                              | `TEST-ING-002-BLOCK`, U01...U03                                            | `packages/service/test/integration/knowledge-import.test.ts`; E2E import                                        | Local storage                |
| URL             | SSRF guard, pinned request                             | `TEST-ING-003-U01...U05`, `TEST-X-SECURITY-URL`                            | `test/fault/knowledge-import-fault.test.ts:20`; import integration                                              | No real external credentials |
| Template        | CSV/XLSX validation                                    | `TEST-ING-004-BLOCK`, U01...U03                                            | `packages/parse/test/unit/import-template.test.ts:48`                                                           | Local fixtures               |
| Backup          | Dry-run/fail/skip/overwrite                            | `TEST-ING-005-BLOCK`, U01...U03, `TEST-X-S4-BACKUP-DRYRUN`                 | `packages/parse/test/unit/import-template.test.ts:105`; import integration                                      | Local fixtures               |
| Custom API      | Fixed paths/methods/page modes, detail/content/preview | `TEST-ING-006-BLOCK`, U01...U04, `TEST-API-002-BLOCK`                      | `test/contract/knowledge-api-library.test.ts:65`                                                                | `EXTERNAL_UNVERIFIED`        |
| Feishu          | Two-page cursor, token refresh                         | `TEST-ING-007-BLOCK`, `TEST-X-CONNECTOR-TOKEN`                             | `test/contract/knowledge-s4-providers.test.ts:20`                                                               | `EXTERNAL_UNVERIFIED`        |
| Yuque           | `repo/toc/doc` composite IDs                           | `TEST-ING-008-BLOCK`, `TEST-X-CONNECTOR-DELETE`                            | `test/contract/knowledge-s4-providers.test.ts:42`                                                               | `EXTERNAL_UNVERIFIED`        |
| DingTalk        | `wiki/node/doc` online documents                       | `TEST-ING-009-BLOCK`                                                       | `test/contract/knowledge-s4-providers.test.ts:85`                                                               | `EXTERNAL_UNVERIFIED`        |
| Connector state | AES-GCM, CAS, sync, delete                             | `TEST-X-S4-CONNECTOR-CAS`, `TEST-X-CONNECTOR-DELETE`, `TEST-X-SECRET-LEAK` | `packages/service/test/integration/knowledge-connector.test.ts:85`                                              | Local fixtures               |
| Import UI       | Catalog selection and provider-bound submit            | `ACC-UI-05`, `ACC-UI-06`                                                   | `test/e2e/knowledge-import.test.ts`; connector Mongo integration                                                | Browser capture + Mongo      |

Provider error fixtures cover auth, rate-limit, structured not-found,
cursor/page behavior and non-document rejection. External provider credentials
and live API compatibility remain outside S4 evidence.
