# Deferred operation 清单

以下 74 个 operation 存在于完整目标合同，但不进入 runtime registry，不在
控制台显示为可用。

| 分组        | Operation ID                                                                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Space       | `API-SPACE-REFERENCES`、`API-SPACE-MOVE`、`API-SPACE-BATCH`、`API-SPACE-EXPORT`                                                                                                  |
| Directory   | `API-DIRECTORY-MOVE`                                                                                                                                                             |
| Source      | `API-SOURCE-MOVE`、`API-SOURCE-BATCH`、`API-SOURCE-PREVIEW`、`API-SOURCE-DOWNLOAD`、`API-SOURCE-ARCHIVE`                                                                         |
| Segment     | `API-SEGMENT-BATCH`、`API-SEGMENT-INDEX-CREATE`、`API-SEGMENT-INDEX-UPDATE`、`API-SEGMENT-INDEX-DELETE`、`API-SEGMENT-HISTORY`、`API-SEGMENT-REINDEX`                            |
| Import      | `API-IMPORT-FILES`、`API-IMPORT-TEXT`、`API-IMPORT-URL`、`API-IMPORT-TEMPLATE`、`API-IMPORT-BACKUP`、`API-IMPORT-API-CATALOG`、`API-IMPORT-API-LIBRARY`                          |
| Connector   | `API-CONNECTOR-CONNECT`、`API-CONNECTOR-CATALOG`、`API-CONNECTOR-IMPORT`、`API-CONNECTOR-SYNC`、`API-CONNECTOR-UPDATE`、`API-CONNECTOR-GET`、`API-CONNECTOR-DELETE`              |
| Upload      | `API-UPLOAD-INIT`、`API-UPLOAD-PRESIGN`、`API-UPLOAD-PART`、`API-UPLOAD-COMPLETE`、`API-UPLOAD-ABORT`、`API-UPLOAD-GET`                                                          |
| File        | `API-FILE-PREVIEW`、`API-FILE-CONTENT`、`API-FILE-DOWNLOAD`                                                                                                                      |
| Job         | `API-JOB-CREATE`、`API-JOB-RETRY`、`API-JOB-CANCEL`、`API-JOB-PAUSE`、`API-JOB-RESUME`、`API-JOB-REPLAY`                                                                         |
| Search      | `API-SEARCH-SEMANTIC`、`API-SEARCH-FULLTEXT`、`API-SEARCH-HYBRID`、`API-SEARCH-IMAGE`、`API-SEARCH-MULTI`、`API-SEARCH-DEEP`                                                     |
| Citation    | `API-CITATION-GET`                                                                                                                                                               |
| Model       | `API-MODEL-LIST`、`API-MODEL-BINDING-GET`、`API-MODEL-BINDING-UPDATE`、`API-MODEL-BINDING-VALIDATE`                                                                              |
| API Key     | `API-APIKEY-LIST`、`API-APIKEY-CREATE`、`API-APIKEY-UPDATE`、`API-APIKEY-DELETE`、`API-APIKEY-ROTATE`                                                                            |
| Usage/Audit | `API-USAGE-GET`、`API-AUDIT-LIST`                                                                                                                                                |
| Ops         | `API-OPS-CLEANUP`、`API-OPS-RECONCILE`、`API-OPS-OUTBOX-REPLAY`                                                                                                                  |
| Synonym     | `API-SYNONYM-GET`、`API-SYNONYM-UPLOAD`、`API-SYNONYM-UPDATE`、`API-SYNONYM-DELETE`、`API-SYNONYM-DOWNLOAD`、`API-SYNONYM-MAPPINGS`、`API-SYNONYM-ENABLE`、`API-SYNONYM-REBUILD` |

固定拆分：

```text
runtime 46
deferred 74
runtime ∩ deferred = ∅
runtime ∪ deferred = 120
```
