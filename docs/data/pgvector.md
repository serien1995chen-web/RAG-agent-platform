# PostgreSQL/pgvector

## 四维 profile

| dimension | storage   | distance | HNSW opclass         |
| --------: | --------- | -------- | -------------------- |
|       768 | `vector`  | cosine   | `vector_cosine_ops`  |
|      1024 | `vector`  | cosine   | `vector_cosine_ops`  |
|      1536 | `vector`  | cosine   | `vector_cosine_ops`  |
|      3072 | `halfvec` | cosine   | `halfvec_cosine_ops` |

每维使用独立表。`knowledge_vector_profiles` 记录 profileId、modelId、
dimension、storageType、tableName、distanceMetric 和状态。

## 写入与查询

- 写入前执行 L2 normalization。
- 维度与 profile 不一致时返回 `KNOWLEDGE_VALIDATION_FAILED`，不得写错表。
- 所有 SQL 强制 `workspace_id`、`knowledge_space_id` 和索引版本条件。
- `vectorId` 使用设计固定的 RFC 4122 UUIDv5。
- 模型切换先写新版本，校验通过后切换 Segment 指针，再清理旧版本。
- 旧 `modeldata` 与 1536-only DDL 不得出现在 canonical 实现。
