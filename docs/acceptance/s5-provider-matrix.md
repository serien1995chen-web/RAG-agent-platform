# S5 Provider Matrix

## AIProxy

| Check                                   | Evidence class       | Phase 1 result                      |
| --------------------------------------- | -------------------- | ----------------------------------- |
| Compose service/profile/digest          | Static real contract | PASS in `s5-compose-config.test.ts` |
| AIProxy PostgreSQL independent database | Static real contract | PASS                                |
| AIProxy `/api/status` live probe        | Real network         | NOT_RUN until phase 2 Compose smoke |
| AIProxy `/v1/models` live probe         | Real network         | NOT_RUN until phase 2 Compose smoke |
| Catalog HTTP fake                       | Mock contract        | PASS                                |
| Model invocation HTTP fake              | Mock contract        | PASS                                |
| Upstream model generation               | External provider    | `EXTERNAL_UNVERIFIED`               |

An empty `/v1/models` catalog may prove gateway reachability only. It does not
prove that an upstream model is usable.

## Parsing

| Check                        | Evidence class              | Phase 1 result                               |
| ---------------------------- | --------------------------- | -------------------------------------------- |
| LiteParse 2.0.8 real package | Local real package          | PASS                                         |
| LiteParse PDF parse          | Local real package          | PASS                                         |
| PDF.js fallback              | Local real fallback         | PASS, limited to LiteParse load/init failure |
| OFD clean-room parser        | Local deterministic fixture | PASS                                         |
| anydoc magic/MIME routing    | Local deterministic fixture | PASS                                         |
| Hostile archive rejection    | Local security fixture      | PASS                                         |

## OCR

| Provider                 | Phase 1 evidence                  | Result                |
| ------------------------ | --------------------------------- | --------------------- |
| Sangfor                  | HTTP fake contract                | `MOCK_PASS`           |
| Somark                   | HTTP fake contract                | `MOCK_PASS`           |
| Textin                   | HTTP fake contract                | `MOCK_PASS`           |
| Doc2x                    | HTTP fake preupload/poll contract | `MOCK_PASS`           |
| External OCR credentials | None supplied                     | `EXTERNAL_UNVERIFIED` |
| OCR timeout/fallback     | Injected fault                    | PASS                  |

No mock OCR result is labeled as a real provider result.

## Usage and Audit

- Model and OCR usage events use stable event IDs and Mongo unique indexes.
- Usage fact and `knowledge-outbox` event are created in one Mongo transaction.
- Logs and evidence avoid prompts, authorization headers, credentials, complete
  image URLs with query strings, object keys, and raw provider responses.
