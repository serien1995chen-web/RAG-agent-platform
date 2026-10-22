# 知识库架构基座验收记录

> 状态：`READY_FOR_INDEPENDENT_ACCEPTANCE`
> 实施边界：本记录证明架构基座，不代表 69 项业务能力或真实外部 Provider
> 已完整交付。

## 1. Baseline

| 项目              | 值                                                                 |
| ----------------- | ------------------------------------------------------------------ |
| Branch            | `feat/kb-architecture-baseline`                                    |
| Base main         | `6505a74e3ee48c9471283191708566ed2c3cb772`                         |
| Evidence HEAD     | `28035a150239287335068ed452c6e89115a5855d`                         |
| Repair plan SHA   | `406A3BA2C585DDE3BD72168A1FB342441C6CB45AB282CAF5F825E4927F51B6C9` |
| Acceptance SHA    | `C1AA27718407875F027DE6EA39EE4CE82431E2C1B08EDBB97721814388DBCB49` |
| Target design SHA | `8E5E7300C651C4FE0478B87FC3572ADD52F95C3E49C8F15700B45BB8C690A26D` |
| Historical SHA    | `09745F52977492EBDD783605D91ABD031D5D6EA146AC86B1A7FAA98D557851A5` |
| P0-P8 SHA         | `3ADD3D3CE1CC127A1B6FE3370EEB64E21807E5F3287359B67B52F1C99C4BB096` |

本地提交：

```text
73bacda chore(knowledge): establish architecture baseline governance
d65cf66 feat(knowledge): freeze target contract and runtime boundary
2d39aa1 feat(knowledge): add canonical persistence and infrastructure ports
28035a1 feat(knowledge): complete architecture baseline runtime and console
```

## 2. Work Packages

| WP  | 状态                     | 证据                                                       |
| --- | ------------------------ | ---------------------------------------------------------- |
| WP0 | PASS                     | 权威顺序、硬切、Deferred、外部 mock、分支纪律              |
| WP1 | PASS                     | 92/120/139 contract，46 runtime，74 deferred               |
| WP2 | PASS                     | 23 Mongo、4 pgvector profile、13 BullMQ、Outbox/ObjectRef  |
| WP3 | PASS                     | Space/Directory/Source/Segment/Tag/ACL/Collaborator/Job    |
| WP4 | PASS                     | App Shell、9 页面、真实 API、3 viewport、axe               |
| WP5 | PASS_WITH_BLOCKED_DEPLOY | 静态门禁、真实测试、构建通过；镜像/Compose health 用户负责 |

## 3. Command Evidence

所有验收门禁均独立执行。

| ACC         | Command                                       | Exit | 关键结果                                                |
| ----------- | --------------------------------------------- | ---: | ------------------------------------------------------- |
| ACC-GATE-01 | `pnpm lint`                                   |    0 | 全仓无 lint error                                       |
| ACC-GATE-02 | `pnpm format:check`                           |    0 | Prettier 全部通过                                       |
| ACC-GATE-03 | `pnpm typecheck`                              |    0 | 12/12 workspace                                         |
| ACC-GATE-04 | `pnpm architecture:check`                     |    0 | 39 个 service 源文件，无禁止依赖/循环                   |
| ACC-GATE-05 | `pnpm forbidden-files:check`                  |    0 | 213 文件，无禁止依赖/来源素材                           |
| ACC-GATE-06 | `pnpm license:check`                          |    0 | 12 workspace、59 catalog、236 生产组件                  |
| ACC-GATE-07 | `pnpm sbom:generate`                          |    0 | SBOM 与 NOTICE 生成                                     |
| ACC-GATE-08 | `pnpm openapi:generate && pnpm openapi:check` |    0 | 92/120/139，runtime 46 / deferred 74                    |
| ACC-GATE-09 | `pnpm knowledge:inventory`                    |    0 | 73 Capability；23/4/13                                  |
| ACC-GATE-10 | `pnpm knowledge:check-runtime`                |    0 | 46/74，交集 0，并集 120，旧 route 0                     |
| ACC-GATE-11 | `pnpm test:unit`                              |    0 | Turbo 20/20 task                                        |
| ACC-GATE-12 | `pnpm test:contract`                          |    0 | 4/4 tests                                               |
| ACC-GATE-13 | `pnpm test:integration`                       |    0 | Turbo 20/20；knowledge infrastructure/application 10/10 |
| ACC-GATE-14 | `pnpm test:tenant`                            |    0 | 2/2 tests                                               |
| ACC-GATE-15 | `pnpm test:concurrency`                       |    0 | 1/1 CAS test                                            |
| ACC-GATE-16 | `pnpm test:fault`                             |    0 | 4/4 tests，含 readiness 503 Problem                     |
| ACC-GATE-17 | `pnpm test:e2e`                               |    0 | 3/3 tests；46 operation 全覆盖                          |
| ACC-GATE-18 | `pnpm build && pnpm build:workers`            |    0 | 12/12 + 9/9 Turbo tasks                                 |
| ACC-GATE-19 | `docker compose ... config`                   |    0 | 配置可解析；无 `latest`                                 |
| ACC-GATE-20 | Compose image/health                          |  N/A | `BLOCKED_BY_USER_IMAGE_OWNERSHIP`                       |

Compose 静态命令：

```bash
docker compose -f deploy/docker-compose.yml config
```

静态断言结果：

```json
{
  "appImage": "rag-agent-platform:kb-baseline",
  "workerImage": "rag-agent-platform:kb-baseline",
  "appCommand": "pnpm --filter @kb/app start",
  "workerCommand": "node projects/app/dist/workers/worker.mjs",
  "appPorts": "3010:3010",
  "workerPorts": 0,
  "dependencies": ["mongo=True", "redis=True", "pgvector=True", "minio=True"],
  "usesLatest": false
}
```

用户明确要求 Docker 镜像由其团队构建，因此本轮未完成镜像构建和 Compose
运行态 health。该阻断不是代码测试失败。

## 4. Contract And Runtime

- paths：92
- operations：120
- schemas：139
- parameters：8
- runtime：46
- deferred：74
- runtime/deferred 交集：0
- runtime/deferred 并集：120
- Deferred route 未注册，UI 未提供可用入口。

`test/e2e/knowledge-baseline.test.ts` 对 46 个 runtime operation 逐一执行
HTTP 请求，并校验请求体与成功响应的 OpenAPI Schema。最终 coverage set 与
runtime registry 的 46 个 operationId 完全一致。

## 5. Infrastructure Evidence

| Store      | Evidence                                                             |
| ---------- | -------------------------------------------------------------------- |
| Mongo      | `kb_integration_final` 现场查询 23 个 `knowledge_*` collection       |
| PostgreSQL | 768/1024/1536 `vector`、3072 `halfvec` 四个 active profile           |
| pgvector   | 四张维度表均存在 HNSW index，查询计数为 4                            |
| Redis      | 现场扫描到 13 个 `bull:knowledge-*` queue meta                       |
| MinIO      | `kb-test` bucket 存在；integration 完成真实 put/get/delete ObjectRef |
| Worker     | 最终 `worker.mjs` 启动并写入 `/tmp/knowledge-worker-ready`           |

23 collections 直接查询结果：

```text
knowledge_api_keys, knowledge_audit_events, knowledge_citations,
knowledge_collaborators, knowledge_connector_cursors, knowledge_connectors,
knowledge_directories, knowledge_idempotency_records, knowledge_job_steps,
knowledge_jobs, knowledge_model_bindings, knowledge_object_refs,
knowledge_outbox_events, knowledge_reference_bindings,
knowledge_resource_permissions, knowledge_segments, knowledge_sources,
knowledge_spaces, knowledge_synonym_configs, knowledge_synonym_mappings,
knowledge_tag_values, knowledge_tags, knowledge_usage_events
```

13 queues：

```text
knowledge-import, knowledge-parse, knowledge-segment, knowledge-qa,
knowledge-ocr, knowledge-caption, knowledge-embed, knowledge-index,
knowledge-rebuild, knowledge-sync, knowledge-delete, knowledge-outbox,
knowledge-cleanup
```

## 6. Security And Fault Evidence

- 所有 repository 查询使用 `workspaceId`，跨租户解析统一失败。
- 同版本并发更新只有一个成功，其余返回 `KNOWLEDGE_CONFLICT`。
- Source permission enable/detach/resume/disable 均递增 `permissionRevision`。
- Job 领取、开始与提交使用 CAS、lease、attemptEpoch、fencing token。
- Outbox 与业务文档在同一个 Mongo transaction 中写入。
- Redis 投递失败时 Outbox 保持 failed，不伪造 published。
- `/readyz` 依赖失败返回 503 `KNOWLEDGE_DEPENDENCY_UNAVAILABLE` Problem。
- 外部 Provider 具备判别联合合同、timeout、错误分类、redaction 和 mock。

## 7. Browser Evidence

Playwright 对 9 个基座页面执行 1200/768/360 三档 viewport 检查：

- 页面数：9
- viewport：3
- 截图：18（桌面 + mobile，文件位于本轮外部 `work/playwright/screenshots/`）
- console error：0
- page error：0
- failed request：0
- 旧 API request：0
- 布局溢出/重叠：0
- axe WCAG serious/critical violation：0
- 实际 API 请求全部为 `/v1/knowledge/*`

## 8. External Status

| Provider | 状态                  |
| -------- | --------------------- |
| AIProxy  | `EXTERNAL_UNVERIFIED` |
| OCR      | `EXTERNAL_UNVERIFIED` |
| 飞书     | `EXTERNAL_UNVERIFIED` |
| 语雀     | `EXTERNAL_UNVERIFIED` |
| 钉钉     | `EXTERNAL_UNVERIFIED` |

以上 Provider 不得标记为真实联调或 PASS。

## 9. Release And Legal Follow-Up

`license:check` exit 0，但输出保留三条发布侧 pending-legal-review：

- `caniuse-lite@1.0.30001814`：CC-BY-4.0
- `pako@1.0.11`：MIT AND Zlib
- `sax@1.6.1`：BlueOak-1.0.0

这些不阻断当前 CI/架构基座验收，阻断对外发布，需法律/发布负责人处理。

## 10. Not Implemented In This Baseline

- F1：完整导入、文件/连接器、上传、对象生命周期。
- F2：完整 Job executor、解析/QA/caption/embedding/index/rebuild 执行链。
- F3：真实 search、Rerank、Citation 和下游集成。
- F4：同义词、API Keys、usage/audit 运营、cleanup/reconcile/replay。
- F5：AIProxy/OCR/飞书/语雀/钉钉真实 Provider 集成。

## 11. Fixed Statement

本基座验收不代表 69 项知识库业务能力已完成，也不代表已达到 FastGPT 完整效果。

未执行 push/PR/merge，等待第二位 Codex 独立验收。
