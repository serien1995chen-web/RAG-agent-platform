# PostgreSQL / pgvector（ADR-002）

> DDL 落点：`deploy/init/pgvector.sql`；集成测试：`packages/service/test/integration/pgvector.test.ts`。

## 1. 冻结结构

- 表 `modeldata`：`id TEXT PRIMARY KEY`、`vector VECTOR(1536)`、`team_id`、`dataset_id`、`collection_id`、`index_version`、`createtime TIMESTAMPTZ DEFAULT now()`。
- 索引：`modeldata_vector_hnsw`（cosine，m=32/ef_construction=128）、`modeldata_team_dataset_collection_idx`（含 index_version）、`modeldata_createtime_idx`。
- DDL 幂等：重复执行不改变已有定义；Compose 首次初始化挂载到 `/docker-entrypoint-initdb.d/01-pgvector.sql`。

## 2. 查询规则

1. 所有 SELECT/INSERT/UPDATE/DELETE 必须包含 `team_id`；缺失 teamId/datasetId/collectionId 时 Adapter 拒绝执行并抛稳定错误。
2. `index_version` 由 Dataset/Collection 权威版本注入；pinned 查询同时过滤版本，latest 过滤当前权威版本；不匹配返回 501050。
3. 余弦距离 `<=>` 对外统一换算为 `score = 1 - distance`。
4. 维度固定 1536；维度变化必须经过显式迁移与重建（ACC-DATA-004）。

## 3. 验证

```bash
docker compose -f deploy/docker-compose.yml up -d --pull never
pnpm --filter @kb/service test:integration
```

覆盖：DDL 幂等、表结构与三个索引存在、带完整租户谓词的向量写入/召回、跨租户零命中。
