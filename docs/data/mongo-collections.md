# MongoDB 集合与索引（骨架版）

> 权威依据：设计文档 10.2-10.10、18.8；所有 Schema 位于 `packages/service/src/shared/persistence/schemas/`。

## 1. 八个集合

| 集合                  | 领域对象         | 关键字段                                                                                                                                | 索引（均由 defineIndex 声明）                                                                        |
| --------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `datasets`            | KnowledgeBase    | teamId、createdBy、parentId、type、name、vectorModel、indexVersion、chunkPolicy、inheritPermission、autoSync、deleteTime、version(派生) | `ds_datasets_team_parent_idx`、`ds_datasets_team_delete_update_idx`、`ds_datasets_team_autosync_idx` |
| `dataset_collections` | SourceCollection | teamId、datasetId、parentId、type、tagIds、sourceRef、externalFileIdNormalized、trainingPolicy、trainingState                           | 树/类型/标签索引 + `ds_dataset_collections_team_external_file_unique`（部分唯一）                    |
| `dataset_datas`       | KnowledgeItem    | teamId、datasetId、collectionId、q/a/imageId、indexes[]、dedupKey、rebuilding                                                           | chunk、`indexes.dataId`、`ds_dataset_datas_team_dedup_unique`（部分唯一）                            |
| `dataset_data_texts`  | 全文投影         | teamId、datasetId、collectionId、dataId、fullTextToken                                                                                  | `teamId_1_fullTextToken_text`（default_language=none）、scope、dataId hashed                         |
| `dataset_trainings`   | ProcessingJob    | teamId、datasetId、collectionId、mode、retryCount、lockTime、weight、expireAt                                                           | claim、scope、TTL `ds_dataset_trainings_expire_ttl_idx`（7 天）                                      |
| `dataset_tags`        | CollectionTag    | teamId、datasetId、name                                                                                                                 | `ds_dataset_tags_team_name_unique`                                                                   |
| `image_assets`        | ImageAsset       | imageId、teamId、datasetId、objectKey、ttlExpireAt、persistent、state                                                                   | `ds_image_assets_team_image_unique`、TTL/持久化、scope                                               |
| `dataset_acl`         | 资源 ACL         | teamId、resourceType/Id、collaboratorType/Id、permission、permissionMask、inheritEnabled、version、source                               | collaborator 唯一 + resource/collaborator 查询索引                                                   |

## 2. 规则

1. 所有集合必须携带 `teamId`；Repository/Adapter 查询缺少 teamId 谓词时抛稳定错误。
2. 禁止字段级 `index/unique` 与直接 `schema.index()`；统一经 `defineIndex(schema, { key, options, deprecated })`。
3. 部分唯一索引条件为字段为非空字符串（`externalFileIdNormalized`、`dedupKey`）。
4. TTL 常量来自 ADR-012（Training 7 天）；图片单一绝对到期时间由 `ttlExpireAt` 表达。
5. `datasets.version` 为派生 CAS 字段：10.3 未登记，但更新 DTO 与 Repository 契约要求版本控制（SKEL-ADR-008 proposed）。

## 3. 集成验证

```bash
docker compose -f deploy/docker-compose.yml up -d --pull never
pnpm --filter @kb/service test:integration
```

覆盖：8 集合创建、defineIndex 声明、部分唯一索引/TTL 参数、websiteDataset 与 mode=auto 被 Schema 拒绝。
