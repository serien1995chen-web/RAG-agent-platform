# 知识库架构基座 ADR 索引

> 状态：`feat/kb-architecture-baseline` 已实施。
> 权威顺序：用户决策 > 目标设计 1.0.0 > 当前源码事实。
> 历史设计和 P0-P8 仅用于解释历史，不作为当前实现依据。

| ADR     | 决策                                                                                    | 状态   |
| ------- | --------------------------------------------------------------------------------------- | ------ |
| ADR-001 | 冻结目标合同为 92 paths、120 operations、139 schemas、8 parameters                      | 已实施 |
| ADR-002 | canonical API 只使用 `/v1/knowledge/*`，不保留旧 alias 或双读                           | 已实施 |
| ADR-003 | `workspaceId` 是唯一租户键，所有 repository 查询必须携带它                              | 已实施 |
| ADR-004 | 写操作使用 CAS；权限变化同时递增 `permissionRevision`                                   | 已实施 |
| ADR-005 | Mongo 业务事实与 Outbox 在同一事务写入，BullMQ 只负责投递                               | 已实施 |
| ADR-006 | Job 使用 CAS、租约、attempt epoch 与 fencing token                                      | 已实施 |
| ADR-007 | 只保留 23 个 `knowledge_*` Mongo 集合                                                   | 已实施 |
| ADR-008 | pgvector 提供 768/1024/1536 `vector` 与 3072 `halfvec` 四个 profile                     | 已实施 |
| ADR-009 | 只保留 13 个 `knowledge-*` BullMQ 队列                                                  | 已实施 |
| ADR-010 | runtime 只注册当前阶段批准的 operation，其余进入 Deferred manifest；S3 结束基线为 65/55 | 已实施 |
| ADR-011 | AIProxy、OCR、飞书、语雀、钉钉只做判别联合合同与 mock                                   | 已实施 |
| ADR-012 | 外部 Provider 未取得真实凭证和联调证据时固定标记 `EXTERNAL_UNVERIFIED`                  | 持续   |
| ADR-013 | UI 只提供基座 App Shell 与九个稳定页面，不展示 Deferred 可用入口                        | 已实施 |
| ADR-014 | 不执行旧数据自动迁移，不新增未批准接口兼容窗口                                          | 已实施 |

## 运行边界

- 真实基础设施：MongoDB replica set、Redis、PostgreSQL/pgvector、MinIO。
- 系统探针：`/healthz` 与 `/readyz`；依赖故障返回 503 Problem。
- 合同按 operation ID 冻结，不在运行时注册 Deferred route。
- 错误码只使用 `KNOWLEDGE_*`。
- 旧 Dataset 聚合、旧集合、旧队列和旧错误目录均已退出 canonical runtime。

## 后续能力

F1-F5（导入/文件、Job 执行、搜索/引用、治理、真实外部 Provider）属于后续业务能力，不在本架构基座中宣称完成。
