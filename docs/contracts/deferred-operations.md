# Deferred operation 清单

以下 55 个 operation 存在于完整目标合同，但不进入 runtime registry，不在
控制台显示为可用。

| 分组       | Operation ID                                                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Segment    | `API-SEGMENT-HISTORY`、`API-SEGMENT-INDEX-CREATE`、`API-SEGMENT-INDEX-DELETE`、`API-SEGMENT-INDEX-UPDATE`、`API-SEGMENT-REINDEX`、`API-SEGMENT-BATCH`                            |
| Import     | `API-IMPORT-API-LIBRARY`、`API-IMPORT-API-CATALOG`、`API-IMPORT-BACKUP`、`API-IMPORT-FILES`、`API-IMPORT-TEMPLATE`、`API-IMPORT-TEXT`、`API-IMPORT-URL`                          |
| Connector  | `API-CONNECTOR-DELETE`、`API-CONNECTOR-GET`、`API-CONNECTOR-UPDATE`、`API-CONNECTOR-SYNC`、`API-CONNECTOR-CATALOG`、`API-CONNECTOR-CONNECT`、`API-CONNECTOR-IMPORT`              |
| Job        | `API-JOB-CREATE`、`API-JOB-CANCEL`、`API-JOB-PAUSE`、`API-JOB-REPLAY`、`API-JOB-RESUME`、`API-JOB-RETRY`                                                                         |
| Search     | `API-SEARCH-DEEP`、`API-SEARCH-FULLTEXT`、`API-SEARCH-HYBRID`、`API-SEARCH-IMAGE`、`API-SEARCH-MULTI`、`API-SEARCH-SEMANTIC`                                                     |
| Citation   | `API-CITATION-GET`                                                                                                                                                               |
| Model      | `API-MODEL-BINDING-VALIDATE`、`API-MODEL-LIST`、`API-MODEL-BINDING-GET`、`API-MODEL-BINDING-UPDATE`                                                                              |
| API Key    | `API-APIKEY-LIST`、`API-APIKEY-CREATE`、`API-APIKEY-DELETE`、`API-APIKEY-UPDATE`、`API-APIKEY-ROTATE`                                                                            |
| Usage      | `API-USAGE-GET`                                                                                                                                                                  |
| Audit      | `API-AUDIT-LIST`                                                                                                                                                                 |
| Operations | `API-OPS-CLEANUP`、`API-OPS-OUTBOX-REPLAY`、`API-OPS-RECONCILE`                                                                                                                  |
| Synonym    | `API-SYNONYM-DELETE`、`API-SYNONYM-GET`、`API-SYNONYM-ENABLE`、`API-SYNONYM-UPLOAD`、`API-SYNONYM-UPDATE`、`API-SYNONYM-DOWNLOAD`、`API-SYNONYM-MAPPINGS`、`API-SYNONYM-REBUILD` |

固定拆分：

```text
runtime 65
deferred 55
runtime ∩ deferred = ∅
runtime ∪ deferred = 120
```
