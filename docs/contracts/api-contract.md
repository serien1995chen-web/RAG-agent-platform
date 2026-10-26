# Knowledge API 合同

## 固定规模

| 项目                 | 数量 |
| -------------------- | ---: |
| paths                |   92 |
| operations           |  120 |
| component schemas    |  139 |
| component parameters |    8 |
| runtime operations   |   65 |
| deferred operations  |   55 |

完整合同是唯一目标合同；运行时只注册当前阶段批准的 operation。Deferred
operation 不得用占位路由、骨架占位码、200 空对象或其他假成功实现。

## 公共合同

| 项目      | 规则                                                                            |
| --------- | ------------------------------------------------------------------------------- |
| Base path | `/v1/knowledge`                                                                 |
| 健康检查  | `/healthz`、`/readyz`                                                           |
| 认证      | JWT 或 scoped API Key                                                           |
| 租户      | `X-Workspace-Id` 必填                                                           |
| trace     | `traceparent`、`traceId`、`X-Request-Id`                                        |
| 幂等      | 写操作需要 `Idempotency-Key`                                                    |
| 分页      | `cursor` + `limit`，1–200，默认 50                                              |
| 成功响应  | `{ success, data, traceId, requestId }`                                         |
| 错误响应  | `{ success:false, error:{code,message,retryable,details}, traceId, requestId }` |
| 错误码    | 只允许 `KNOWLEDGE_*`                                                            |

## Runtime 65

`4 + 6 + 3 + 2 + 13 + 5 + 10 + 7 + 9 + 6 = 65`

| 分组      | Operation                                                              |
| --------- | ---------------------------------------------------------------------- |
| System    | `API-HEALTH-LIVE`、`API-HEALTH-READY`、`API-OPENAPI`、`API-OPS-STATUS` |
| Space     | `LIST`、`CREATE`、`GET`、`UPDATE`、`DELETE`                            |
| Directory | `LIST`、`CREATE`、`GET`、`UPDATE`、`DELETE`                            |
| Source    | `LIST`、`CREATE`、`GET`、`UPDATE`、`DELETE`                            |
| Segment   | `LIST`、`CREATE`、`GET`、`UPDATE`、`DELETE`                            |
| Tag       | `LIST`、`CREATE`、`GET`、`UPDATE`、`DELETE`、`VALUES`、`APPLY`         |
| ACL       | 3 ACL + 4 collaborator + 4 permission + 2 ownership                    |
| Job       | `LIST`、`GET`                                                          |

## Deferred

74 个 deferred operation 的唯一清单见
`docs/contracts/deferred-operations.md`。runtime registry 与 deferred manifest
必须无交集，并集恰为 120。
