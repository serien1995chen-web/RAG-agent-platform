# 知识库架构基座

## 权威与范围

本仓库以 `KnowledgeBase-System-Design.md` 1.0.0 为唯一目标设计。用户决策高于
目标设计，目标设计高于当前源码事实；历史设计和 P0-P8 只解释历史。FastGPT
只用于行为消歧，不复制任何源码、Prompt、Schema、部署文件、页面或品牌素材。

基座交付合同、领域、持久化、端口、权限边界、任务语义、运行时装配、控制台壳
和工程门禁。本阶段不宣称 69 项业务能力完成。

## 固定规模

| 项目                | 目标 |
| ------------------- | ---: |
| OpenAPI paths       |   92 |
| OpenAPI operations  |  120 |
| OpenAPI schemas     |  139 |
| runtime operations  |   65 |
| deferred operations |   55 |
| Mongo collections   |   23 |
| pgvector profiles   |    4 |
| BullMQ queues       |   13 |

## 硬切规则

1. 公开 API 只使用 `/v1/knowledge/*`、`/healthz` 和 `/readyz`。
2. 旧 `/api/core/dataset/**`、`/api/internal/dataset/**`、
   `/proApi/core/dataset/**` 不保留 alias。
3. 旧 `datasets`、`dataset_*` 集合和 `dataset-*` 队列退出 canonical runtime。
4. 未批准 operation 不注册运行时路由，不以 501999、空对象或假成功占位。
5. 不执行旧数据自动迁移、双读或双写。

## 一致性与权限

- 每个 repository 查询强制 `workspaceId`，跨租户或不可见资源统一 404。
- 资源更新使用 `version` CAS，冲突返回 `KNOWLEDGE_CONFLICT`。
- 权限状态变化、ACL 主体变化和恢复继承均递增 `permissionRevision`。
- Job 使用 `attemptEpoch`、租约和 fencing token；旧 worker 不能提交副作用。
- Outbox 与业务文档在同一 Mongo 事务中提交，BullMQ 仅做幂等投递。

## 外部依赖

AIProxy、OCR、飞书、语雀和钉钉只实现判别联合合同、timeout、错误分类、
redaction 与 mock。无真实凭证时固定标记 `EXTERNAL_UNVERIFIED`。
