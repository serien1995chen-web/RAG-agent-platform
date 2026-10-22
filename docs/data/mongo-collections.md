# MongoDB canonical 集合

## 集合清单

```text
knowledge_spaces
knowledge_directories
knowledge_sources
knowledge_segments
knowledge_synonym_configs
knowledge_synonym_mappings
knowledge_jobs
knowledge_job_steps
knowledge_tags
knowledge_tag_values
knowledge_resource_permissions
knowledge_collaborators
knowledge_reference_bindings
knowledge_connectors
knowledge_connector_cursors
knowledge_usage_events
knowledge_audit_events
knowledge_outbox_events
knowledge_object_refs
knowledge_api_keys
knowledge_idempotency_records
knowledge_model_bindings
knowledge_citations
```

数量固定为 23。旧 `datasets`、`dataset_*` 集合退出 canonical repository。

## 通用字段与规则

- 所有集合包含适用的 `workspaceId`、时间戳、`version`、`deletedAt` 和 actor。
- Repository 的 find、update、delete、count、aggregate 必须强制 `workspaceId`。
- 缺租户上下文时稳定拒绝，不得以空结果代替。
- 写入使用 `{_id, workspaceId, version}` CAS，成功后 `version + 1`。
- 业务查询默认追加 `deletedAt:null`。
- 索引只能经 `defineIndex` 声明。
- TTL、audit、idempotency、outbox、object ref 和 citation 使用显式过期字段。
- 权限状态或 ACL 主体变化必须递增 `permissionRevision`。

## 事实边界

Mongo `knowledge_jobs` / `knowledge_job_steps` 是 Job 业务真相；BullMQ 只负责
投递。Outbox 事件必须与业务文档和 Job 在同一 Mongo 事务内创建。
