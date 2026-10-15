# 发布证据报告

## 0. 范围与口径

- 阶段：P8 测试发布。
- 基线：设计文档 3.5.1，任务拆解文档 P0-P8 §12。
- 分支：`feat/p8-personB`。
- 代码基线：`2011e3e`（personA PR #20 已合并）；P8-04 任务提交 `453aeb1`。
- 生成本报告时仅记录实际执行的命令、退出码、关键输出和文件路径；未执行的真实联调不得写成通过。
- DTO 统一口径：设计基线为 198 个注册表 DTO；仓库实测为 199 个 DTO，即 198 个注册表 DTO + 1 个派生 `ModelReference`。

## 1. 代码版本与镜像 digest

| 项                       | 证据                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 分支                     | `feat/p8-personB`                                                                                                                                      |
| 基线 commit              | `2011e3ebfa95d93adcbf2f55e5e9cdd7d9a0dee1`                                                                                                             |
| P8-04 commit             | `453aeb1ca13888dab20b4dbf16da74b5c3b82d87`                                                                                                             |
| mongo                    | `registry.cn-hangzhou.aliyuncs.com/fastgpt/mongo:5.0.32@sha256:ab12670508974afbdf3bdc7dd39a201d228a73c9c13c70a684b9eedfb063dc3e`                       |
| redis                    | `registry.cn-hangzhou.aliyuncs.com/fastgpt/redis:7.2-alpine@sha256:2bf71743152d3ca631d358029d504fed349ea28179667acfa755dffb4b321e7c`                   |
| pgvector                 | `registry.cn-hangzhou.aliyuncs.com/fastgpt/pgvector:0.8.0-pg15@sha256:92be4ea0424cccf17003f5803d54448e2864ac27a70e6ac5d24b3d8b463c689c`                |
| minio                    | `registry.cn-hangzhou.aliyuncs.com/fastgpt/minio:RELEASE.2025-09-07T16-13-09Z@sha256:a63b19df59e6ec7c02ebba6e7a1097b7e032da7947b18db7ff67dae8e84fd44d` |
| app（构建期）            | Compose 构建名 `rag-agent-platform-app`；registry digest 由发布流水线生成后登记                                                                        |
| node:22-alpine（构建期） | 保持具名 tag；digest 未登记，列入发布阻塞项                                                                                                            |

## 2. SBOM 与许可证

| 项                  | 证据                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| NOTICE 路径         | `NOTICE`                                                                                            |
| NOTICE 大小 / 行数  | 59,536 bytes / 541 lines                                                                            |
| NOTICE SHA-256      | `56a1c5c6a1a95398d32e7441bb948d53a6aee04778fc6a25e01c433806f5b655`                                  |
| A 侧生成入口        | `pnpm sbom:generate`（P8-03 已执行；NOTICE 禁止手工维护）                                           |
| SBOM 路径           | `artifacts/sbom.json` 为构建产物，不提交仓库；干净检出中不存在                                      |
| 许可证门禁          | `pnpm license:check` 退出码 0                                                                       |
| 组件统计            | 12 个 workspace 包、59 个 catalog 登记项、236 个生产闭包 npm 组件                                   |
| SPDX 规范化         | `duck@0.1.12` 归一化为 BSD-2-Clause；`jszip@3.10.2` 选择 MIT 分支                                   |
| dev/build-only 审计 | `@csstools/color-helpers@5.1.0`、`argparse@2.0.1`、`lightningcss@1.33.0`、`minimatch@10.2.6` 非阻塞 |
| 发布阻塞            | 3 条 `RELEASE BLOCKER`，待法务复核，详见第 10 节                                                    |

B 未重新生成 `NOTICE`，避免回改 personA 的只读产物；本报告引用 A 的 `pnpm sbom:generate` 证据、当前 NOTICE 哈希和本次 `pnpm license:check` 实测输出。P8-04 的 CI release-smoke 作业会在干净检出中再次生成并校验 `artifacts/sbom.json`。

## 3. OpenAPI 版本与契约结果

`pnpm openapi:check` 退出码 0：

```text
openapi:check 通过：快照一致；87 条路由（已实现 87 条）、199 个 DTO、71 个错误码。
```

- 路由：87/87 已实现。
- DTO：设计基线 198 个注册表 DTO；仓库实测 199 个 DTO（198+1 派生 `ModelReference`）。
- 错误码：501001-501071，共 71 个。
- `client-types.d.ts` 在 A 的 PR 中未改动。

## 4. 环境规格与配置 profile

| 项             | 实测值                                        |
| -------------- | --------------------------------------------- |
| 操作系统       | Ubuntu 22.04.5 LTS（WSL2）                    |
| 内核           | Linux 6.6.87.2-microsoft-standard-WSL2 x86_64 |
| CPU            | AMD Ryzen 9 9950X3D 16-Core Processor         |
| CPU 可见核数   | 32                                            |
| 内存           | 31,598,712 KiB                                |
| Node.js        | v22.23.2                                      |
| pnpm           | 10.33.4                                       |
| Docker Engine  | 29.6.2                                        |
| Docker Compose | v5.3.1                                        |

配置 profile 使用 `deploy/.env.example` 的非承诺默认值：

| 配置                      | profile 值 | 性质                  |
| ------------------------- | ---------- | --------------------- |
| `KB_BATCH_SIZE`           | 100        | 部署注入 / 非产品承诺 |
| `KB_QUEUE_CONCURRENCY`    | 4          | 部署注入 / 非产品承诺 |
| `KB_PROVIDER_CONCURRENCY` | 4          | 部署注入 / 非产品承诺 |
| `KB_MONGO_POOL_SIZE`      | 10         | 部署注入 / 非产品承诺 |
| `KB_REDIS_CONNECTIONS`    | 2          | 部署注入 / 非产品承诺 |
| `KB_PG_POOL_SIZE`         | 10         | 部署注入 / 非产品承诺 |
| `KB_S3_CONCURRENCY`       | 4          | 部署注入 / 非产品承诺 |
| `KB_PROVIDER_TIMEOUT_MS`  | 30000      | 部署注入 / 非产品承诺 |
| `KB_PROVIDER_MAX_RETRIES` | 3          | 部署注入 / 非产品承诺 |

## 5. 测试数据规模、租户混合与 batch

| 测试层              | 实测规模               | 关键输出                                                                  |
| ------------------- | ---------------------- | ------------------------------------------------------------------------- |
| Turbo package tests | 20/20 tasks successful | service 34 文件 / 210 用例；storage 2 文件 / 19 用例；dal 3 文件 / 7 用例 |
| tenant              | 4 文件 / 13 用例       | 跨租户 API、检索、导入与管理边界                                          |
| concurrency         | 2 文件 / 7 用例        | CAS、领取、删除并发                                                       |
| fault               | 8 文件 / 54 用例       | 依赖故障、降级、SSRF、TTL、OTel、导入失败                                 |
| e2e                 | 21 文件 / 113 用例     | 完整 API 到应用链路的合成数据与多租户上下文                               |

测试使用仓库合成数据，不使用生产数据。租户混合由 tenant、e2e 与 service 集成用例承载；batch 默认 profile 为 100，未声明产品容量或吞吐承诺。

## 6. 通过、失败、跳过与阻塞项

Compose 生命周期证据：

| 步骤             | 命令                                                                                                     | 结果                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 启动四个测试依赖 | `docker compose -f deploy/docker-compose.yml up -d --wait --wait-timeout 120 mongo redis pgvector minio` | 退出码 0；mongo、redis、pgvector、minio 均 healthy                          |
| 状态检查         | `docker compose -f deploy/docker-compose.yml ps`                                                         | 4/4 容器 Up (healthy)                                                       |
| 全量测试         | `pnpm test`                                                                                              | 退出码 0；Turbo 20/20；tenant 4/13；concurrency 2/7；fault 8/54；e2e 21/113 |
| 清理环境         | `docker compose -f deploy/docker-compose.yml down`                                                       | 退出码 0；容器与默认网络已删除                                              |

通过：`pnpm test` 的实际统计如上。失败：0。跳过：命令输出未报告跳过用例。阻塞：真实外部 Provider、真实备份介质和真实生产迁移未提供，不能作为已联调或已恢复证据。

## 7. 故障注入点

| 故障类别                               | 证据文件                             |
| -------------------------------------- | ------------------------------------ |
| 通用依赖失败、超时、部分成功、进程重启 | `test/fault/fault-injection.test.ts` |
| 链接 SSRF 与读取限制                   | `test/fault/link-ssrf.test.ts`       |
| Rerank 不可用                          | `test/fault/search-rerank.test.ts`   |
| 检索降级                               | `test/fault/search-degrade.test.ts`  |
| TTL 清理失败                           | `test/fault/ttl-failure.test.ts`     |
| 删除失败                               | `test/fault/delete-fault.test.ts`    |
| OTel exporter 故障                     | `test/fault/otel-failure.test.ts`    |
| 导入处理故障                           | `test/fault/ingest-fault.test.ts`    |

以上文件由 `pnpm test` 执行，均包含非空自动化用例。

## 8. trace、requestId 与日志索引

| 项                     | 证据                                  |
| ---------------------- | ------------------------------------- |
| trace / requestId 契约 | `test/contract/observability.test.ts` |
| 日志字段字典           | `test/contract/log-map.test.ts`       |
| 固定指标               | 43 metrics                            |
| Span 工具              | 13 instruments                        |
| 日志白名单字段         | 13 log fields                         |
| 告警类型               | 7 alert kinds                         |
| 样例 requestId         | `req-1`                               |

`pnpm test` 已覆盖 observability 与 log-map；报告不声称已接入外部日志平台或生产 tracing 后端。

## 9. 迁移、对账与备份恢复

### ACC-OPS

| ID            | 证据                                                                                                 | 状态                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `ACC-OPS-001` | `test/e2e/migration.test.ts`；`packages/service/test/integration/migration-executor.test.ts`         | 已执行；dry-run/apply/resume 契约通过                   |
| `ACC-OPS-002` | `test/e2e/migration.test.ts`；`test/e2e/admin-security.test.ts`                                      | 已执行；Root/跨租户拒绝与脱敏通过                       |
| `ACC-OPS-003` | `packages/service/test/integration/reconcile.test.ts`；`test/concurrency/delete-concurrency.test.ts` | 已执行；单条失败继续、重复对账幂等通过                  |
| `ACC-OPS-004` | `packages/service/test/integration/leader-lock.test.ts`；`test/e2e/sync-scheduler.test.ts`           | 已执行；Scheduler 补齐、重试、未知调度保留通过          |
| `ACC-OPS-005` | `test/contract/backup-mock.test.ts`；`docs/runbooks/backup-restore.md`                               | mock 合同通过；真实三存储恢复未提供介质与工具，保留残余 |

### ACC-MIG

| ID            | 证据                                                                                         | 状态                                           |
| ------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `ACC-MIG-001` | `packages/service/test/integration/migration-executor.test.ts`；`test/e2e/migration.test.ts` | 已执行；dry-run 不写业务/注册表数据            |
| `ACC-MIG-002` | `packages/service/test/integration/migration-executor.test.ts`；`test/e2e/migration.test.ts` | 已执行；同键幂等、并发拒绝                     |
| `ACC-MIG-003` | `packages/service/test/integration/migration-executor.test.ts`；`test/e2e/migration.test.ts` | 已执行；resume 推进 cursor、拒绝 cursor 倒退   |
| `ACC-MIG-004` | `packages/service/test/integration/migration-executor.test.ts`                               | 已执行；未知索引保留                           |
| `ACC-MIG-005` | `packages/service/test/integration/migration-executor.test.ts`                               | 已执行；清理关闭时不删除废弃索引               |
| `ACC-MIG-006` | `test/e2e/migration.test.ts`；`packages/service/test/integration/migration-executor.test.ts` | 已执行；写入模式、窗口、备份要求与计数阻断通过 |
| `ACC-MIG-007` | `test/contract/backup-mock.test.ts`；`docs/runbooks/backup-restore.md`                       | mock 合同与回滚证据通过；真实备份恢复未执行    |
| `ACC-MIG-008` | `packages/service/test/integration/migration-executor.test.ts`                               | 已执行；备份验证或计数失败阻止完成             |

`TEST-OPS-RUNBOOK-001` 由 `test/contract/backup-mock.test.ts` 校验 Runbook 必需字段与 mock 状态；这不是真实恢复演练。

## 10. 性能基线与 mock / real 分区

### 性能与容量基线

- 仅记录环境规格、配置 profile 和设计 §19.6 已规定的规格引用。
- 规格引用包括 `pushData` 200 条 / 10MB、rawText 10MiB、请求体 10MB、候选 100、mixed 80/60、权重 0.5/0.5、图片权重 0.3/0.7、Parse 租约 10 分钟 / 心跳 60 秒、QA 等待 10 分钟、Vector 等待 3 分钟、重试 5 / 重建 50 / 人工恢复 3、Training TTL 7 天、Usage 360 天、删除与 S3 删除 10 次、Sync 3 次、对账窗口 6-2 小时、同步 24 小时、永久锁定 2050-01-01。
- 本次未执行独立压测或容量验收；不声明吞吐、延迟、可用性、RPO 或 RTO 承诺。

### mock / real 分区

| 依赖                                    | 本次证据                            | 边界                                   |
| --------------------------------------- | ----------------------------------- | -------------------------------------- |
| Mongo / Redis / pgvector / MinIO        | Compose 真实本地容器 + 全量测试通过 | 仅本地测试环境，不代表生产拓扑         |
| 模型网关（U-09）                        | mock 合同                           | 真实端点与凭证未提供，禁止写成真实联调 |
| Auth / 容量 / PDF / 备份 / 通知（U-10） | mock 合同或 Runbook                 | 真实服务未提供                         |
| OTLP exporter（U-14）                   | 本地契约测试                        | 外部 Collector 与生产导出未验证        |
| jieba + `default_language:none`（U-17） | 仓库测试                            | 真实全文服务待外部条件复评             |
| 生产迁移范围与备份介质（U-19）          | dry-run / mock / 框架证据           | 真实迁移、恢复和窗口未提供             |

## 11. 已知风险与发布阻塞项

`stage-closed` 不等于可对外发布。以下条目阻断对外发布，不因本报告全绿而消失：

| 阻塞项                      | 状态                           | 依据                                                                  |
| --------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| `caniuse-lite@1.0.30001814` | pending-legal-review，发布阻断 | CC-BY-4.0；`projects/app → next@16.3.0 → caniuse-lite`                |
| `pako@1.0.11`               | pending-legal-review，发布阻断 | MIT AND Zlib；`packages/parse → mammoth@1.11.0 → jszip@3.10.2 → pako` |
| `sax@1.6.1`                 | pending-legal-review，发布阻断 | BlueOak-1.0.0；`sdk/storage → minio@8.0.7 → xml2js@0.6.2 → sax`       |
| U-15 husky/lint-staged      | 未接线                         | 需要用户安装和接线                                                    |
| `node:22-alpine` digest     | 待用户或 CI 登记               | 当前保持具名 tag，未伪造 digest                                       |
| README / LICENSE            | 团队外置，未完成               | Agent 不修改 README、不添加 LICENSE                                   |
| 备份工具与介质              | 未提供                         | 无真实恢复证据                                                        |
| 容量与配额 profile          | 未提供                         | 只有非承诺默认值                                                      |
| 通知 / 工单平台             | 未提供                         | 核心不依赖，扩展未联调                                                |
| PDF Provider 凭证           | 未提供                         | 真实解析 Provider 未联调                                              |
| 模型网关                    | 未提供                         | 仅 mock 合同                                                          |
| mock 开关                   | 待平台配置                     | 生产环境 mock 保护仍按设计约束                                        |

追溯残余：

- V4/V5/V6/V9/V10/V11 由 A 的契约测试覆盖。
- V1/V2/V3/V7/V8 与 `TEST-TRACE-004` 仍依赖设计原文或 Review 只读核验，不能写成自动化已执行。
- 12 个月弃用窗口当前由 `api-compat` 条件式守卫承载，`deprecated=0`；未执行真实弃用调用链。

## 12. 结果

- P8-05 的本地全量测试、Compose 生命周期、OpenAPI、许可证和运行环境证据已完成。
- 本报告不等于对外发布批准；发布阻塞项必须持续由用户、法务或对应外部责任方处理。
