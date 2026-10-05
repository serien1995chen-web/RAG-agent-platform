# 模块边界与骨架落点映射（Phase 0）

> 状态：Phase 0 产出，已落入 WSL 仓库 `~/RAG-agent-platform`（功能分支 `feat/skeleton-monorepo`）。
> 更新日期：2026-10-05
> 权威输入：
> - 设计文档：`C:\Users\Administrator\Documents\Codex\2026-09-25\files-mentioned-by-the-user-49\outputs\知识库系统设计文档.md`
>   - 标注版本 3.3.0（最后更新 2026-09-30），并已应用 2026-10-05 的 P1-06 补值（liteparse/jieba integrity 与 mongo/redis/pgvector/minio digest 已补；版本号与 A23 变更记录未同步）。
>   - SHA-256：`28DFBFBB8E2D59BAB0192A8B3E94C627FEF88C9D0D18D348F5901C84B98433BA`（6921 行，704710 bytes）。
> - 任务书：2026-10-05 版 `pasted-text-1.txt`（1313 行）。
> - 只读参照：FastGPT `D:\Fastgpt\FastGPT`，commit `83e2b803442b31280c0f81df9e5e3502cd3facfd`。
>
> 权威顺序：设计文档 > 任务书 > FastGPT 只读参照。FastGPT 仅用于理解职责切分，不复制源码、函数名、注释、Prompt、目录名、部署文件、环境变量与品牌素材。

## 1. 顶层边界

| 目录 | 职责 | 不允许 | 设计文档落点 |
| --- | --- | --- | --- |
| `docs/` | 边界、契约、数据、Runbook、ADR 的仓库内落点 | 复制来源项目文档与素材 | 18.x、20.1 |
| `packages/` | 与框架无关的库：契约、服务、算法包 | 依赖 Next.js 或宿主框架 | 5.2、5.3、18.1、18.2 |
| `sdk/` | 基础设施 SDK：storage、otel，独立打包与版本化 | 写入业务规则 | 6.1.9（CR-REF-06/07） |
| `projects/app/` | Next.js 宿主：页面、API 路由、进程与 Worker 引导 | 业务规则、直接拼装存储查询 | 5.4、6.4、6.5 |
| `deploy/` | Compose、Dockerfile、.env.example、pgvector DDL | 复制来源部署文件或变量名 | 6.3、6.5.2、10.16 |
| `test/` | 跨包测试：契约、E2E、故障注入、跨租户、并发 | 承载业务实现 | 19.1、19.2 |
| `scripts/` | 门禁脚本：架构、禁止文件、OpenAPI 快照 | 依赖业务代码私有路径 | 18.11 |
| 根配置 | workspace、Turbo 任务图、TS、lint、版本锁定 | 混入业务逻辑 | 6.1.1、6.1.8 |

## 2. 依赖方向（必须机器校验）

```text
允许：
  api          -> application -> domain
  application  -> port <- adapter
  jobs         -> application
  shared       -> 无业务反向依赖
  extensions   -> public port
```

禁止：

- `domain` 导入 Mongoose、pg、S3 SDK、BullMQ、Next.js 或云 SDK。
- `application` 直接拼装 Mongo / S3 / PG 查询。
- `api` 直接访问 Repository 实现。
- `repository` 修改不属于本聚合的业务状态。
- `adapter` 绕过 Port 或跳过 teamId 谓词。
- 循环依赖与跨模块直接导入内部文件；运行时动态加载未登记模块。

验收映射：`ACC-ARCH-001`、`ACC-CODE-001`、`ACC-ARCH-004`（设计文档 5.9、18.2）。

## 3. 落点映射表（设计文档章节 -> 目录/文件）

| 设计文档章节 | 内容 | 骨架落点 |
| --- | --- | --- |
| 0.9 | ADR-001 至 ADR-019 冻结结论 | `docs/adr/README.md` |
| 0.12 / 0.13 | 技术栈对齐登记、P0-01 DTO 闭包登记 | `pnpm-workspace.yaml` catalog、`packages/contracts/src/openapi/` |
| 1.3 | 首期产品边界 | `README.md`（待确认后重写）、`packages/service/src/modules/` 模块清单 |
| 1.5 | 三条写入路径（来源导入 / 直接插入 / 队列推送） | `packages/service/src/modules/{collection,item,processing}/application/` |
| 1.6 | 核心存储职责 | `docs/data/`、`deploy/`、`sdk/storage` |
| 2.7 | 基础内核与 Clean-room 扩展责任 | `projects/app/src/extensions/`、`packages/service/src/ports/` |
| 2.8 | 首期排除与拒绝规则（含 websiteDataset 拒绝） | 拒绝规则常量（`unsupportedDatasetType`）与创建入口校验 |
| 5.2 / 5.3 | 容器与组件视图、分层职责 | 顶层目录、`packages/service/src/modules/*/` 五层 |
| 5.4 / 5.5 | 部署与 Worker 模型、Runtime 职责 | `projects/app/src/worker/`、`APP_WORKER_MODE` 配置、`packages/dal` |
| 5.7 | 模块边界与调用规则 | `docs/architecture/module-boundaries.md`、`scripts/check-architecture.mjs` |
| 5.8 | 故障降级矩阵 | 依赖探测与 `/readyz`、`DegradationPolicy` Port |
| 5.9 | 架构验收 | `test/contract/` 架构测试 |
| 6.1（6.1.1-6.1.10） | 基线版本矩阵、workspace 内部包、Clean-room 登记、Provider 排除矩阵 | 根 `package.json`、`pnpm-workspace.yaml` catalog、`.nvmrc`、`docs/architecture/clean-room.md` |
| 6.2 | 依赖、许可证与 SBOM 策略 | `scripts/` 许可证与 SBOM 入口（骨架期最小实现）、`docs/architecture/clean-room.md` |
| 6.3 - 6.5 | Compose 拓扑、多副本角色、Worker 生命周期 | `deploy/docker-compose.yml`、`projects/app/src/worker/bootstrap.ts` |
| 6.6 - 6.8 | 外部配置 Schema、环境变量边界、容量档案 | `packages/service/src/shared/config/` |
| 6.9 | 启动、健康与关闭 | `/healthz/live`、`/readyz`、`/startupz` 与启动/关闭顺序实现 |
| 7.1 - 7.4 | 聚合、实体、值对象、关系与不变量 | `packages/service/src/modules/*/domain/` |
| 7.5 | 模块职责（8 个模块） | `packages/service/src/modules/` 模块目录 |
| 7.6 | Repository 与 Port 契约（ADR-010） | `packages/service/src/ports/`（接口 + 默认空实现 + 契约测试） |
| 7.7 | 事件与副作用 | `DatasetEventPort`、扩展注册表 |
| 9.8.1 / 9.9.1 | Parser/Chunk 与 QA 规格 | `packages/parse`、`packages/chunk`、`packages/qa` |
| 10.x | 集合与字段字典 | Mongoose Schema 骨架 + `docs/data/mongo-collections.md` |
| 10.16 | pgvector DDL | `deploy/init/pgvector.sql` |
| 10.17 | 索引、软删除与并发 | `defineIndex` 声明、索引管理器、`MONGO_DEPRECATED_INDEX_CLEANUP` |
| 11.0 | DatasetSearchPort 生产检索契约 | `packages/contracts/src/dataset/search/`、`packages/search` |
| 12.1 | 接口分组（core / admin / internal / proApi） | `projects/app/src/pages/api/{core,admin,internal,proApi}` |
| 12.3 | 统一响应与错误对象 | `packages/contracts/src/common/` |
| 12.4 / 12.4.1 / 12.4.2 | 错误 family、业务码 501001-501071、错误参数 Schema | `packages/contracts/src/errors/`、`packages/service/src/shared/errors/` |
| 12.5 / 12.6 / 12.7 | 请求级幂等、请求限制、API 版本与弃用 | 幂等键工具、上限配置、OpenAPI 元数据 |
| 12.8.1 | 路由契约与 OpenAPI 生成规范 | `scripts/generate-openapi.mjs`、`scripts/check-openapi.mjs` |
| 12.8.2 | DTO 注册表（唯一权威） | `packages/contracts/src/dataset/**`、`packages/contracts/src/openapi/` |
| 12.9 | 路由级接口清单（P0-01 口径 87 条） | 契约注册表 + 路由文件骨架 |
| 12.10 | 异步 Job 契约（稳定 jobId、租约、幂等） | `packages/dal`、`packages/service/src/modules/processing/` |
| 12.11 | API 与异步验收 | `test/contract/` |
| 13.x | 权限、租户隔离与安全 | `packages/acl`、`packages/service/src/modules/permission/` |
| 15.1 / 15.2 | Instrument 清单与指标字典 | `sdk/otel`、`packages/service/src/shared/observability/` |
| 17.x | 数据版本、迁移与兼容 | `packages/service/src/modules/migration/`、`docs/runbooks/` |
| 18.1 / 18.2 | 目录和分层、依赖方向 | 全部骨架 + 门禁脚本 |
| 18.3 - 18.10 | 类型与 Schema、命名、配置、错误、事务、索引、观测、依赖合规 | 各包实现规范与 lint/门禁 |
| 18.11 | Lint、格式、类型与构建门禁 | 根 `package.json` scripts、CI 配置 |
| 18.13 | Definition of Done | `docs/` 与逐阶段验收记录 |
| 19.1 / 19.2 | 测试分层与必测类别（FI/REP/TEN/MIG/RECON） | 各包 `test/` + 仓库根 `test/{contract,e2e,fault,tenant,concurrency,helpers}` |
| 19.4 / 19.4.2 / 19.4.3 | 契约与追溯测试 | `test/contract/`、追溯校验入口 |
| 20.1 / 20.2 | 阶段总览与并行规则 | 任务书第 14 节阶段执行计划 |
| 21.9 | 附录 A9：Port 与 Repository 契约表 | `packages/service/src/ports/` |
| 22.x | 源内容覆盖与追溯校验 | 设计文档追溯要求；仓库内以 `docs/contracts/` 与测试登记 |

## 4. 12 个包与一句话职责

| 包 | 路径 | 一句话职责 | CR |
| --- | --- | --- | --- |
| `@kb/contracts` | `packages/contracts` | DTO、Zod Schema、OpenAPI 元数据、错误码与枚举常量 | CR-REF-03 |
| `@kb/service` | `packages/service` | 领域/应用/仓储/适配器/任务五层业务内核 | CR-REF-02 |
| `@kb/parse` | `packages/parse` | 文档解析与 9 种格式矩阵 | CR-FEATURE-04 |
| `@kb/chunk` | `packages/chunk` | 确定性切分与重叠边界算法 | CR-FEATURE-05 |
| `@kb/qa` | `packages/qa` | QA 生成、Schema 校验与去重 | CR-FEATURE-06 |
| `@kb/search` | `packages/search` | 召回、融合、RRF 与 Rerank | CR-FEATURE-07 |
| `@kb/acl` | `packages/acl` | 权限位与权限真值表 | CR-FEATURE-08 |
| `@kb/dal` | `packages/dal` | 队列、缓存与幂等抽象 | CR-REF-05 |
| `@kb/web` | `packages/web` | 共享前端组件、hooks、i18n 与主题令牌 | CR-REF-04 |
| `@kb/storage` | `sdk/storage` | S3 兼容对象存储适配 | CR-REF-06 |
| `@kb/otel` | `sdk/otel` | trace / metrics / logs 三入口 | CR-REF-07 |
| `@kb/app` | `projects/app` | Next.js 宿主与 Worker 引导 | CR-REF-01 |

## 5. packages/service 八模块与五层骨架

| 模块 | 领域对象 | 关键 Port | 骨架交付 |
| --- | --- | --- | --- |
| `knowledge-base` | KnowledgeBase | `KnowledgeBaseRepository`、`DatasetEventPort` | 实体、用例、Mongo Schema、版本 CAS |
| `collection` | SourceCollection | `CollectionRepository`、`DatasetSourceProvider` | 树形路径、来源引用、训练策略骨架 |
| `item` | KnowledgeItem | `KnowledgeItemRepository` | Data/Chunk/QA/图片引用、bulkUpsert 契约 |
| `index` | KnowledgeItemIndex | `VectorController`、`FullTextStore` | 投影接口与差量同步骨架 |
| `processing` | ProcessingJob | `ProcessingJobRepository`、`TrainingProcessorPort` | enqueue / claim / renew / finish 与租约 |
| `permission` | ACL | `DatasetPermissionPort`、`UpdateDatasetCollaboratorsPort`、`TransferDatasetOwnerPort` | 权限位算法与 `dataset_acl` Schema |
| `delete` | DeleteJob | `FailureQueryPort`、`ReconcileResultPort` | 删除状态机与稳定 jobId |
| `migration` | Migration Registry | `MigrationRegistryPort`、`MongoIndexManagerPort` | Registry 与 dry-run 骨架 |

每个模块统一包含 `domain / application / repository / adapter / jobs` 五层；`api` 层只在 `projects/app`。

## 6. 骨架期决策（proposed，待评审）

| ID | 决策 | 依据 | 风险与升级条件 |
| --- | --- | --- | --- |
| SKEL-ADR-001 | 采用 `packages/ + sdk/ + projects/app` 目录形态 | 任务书第 5 节；设计文档 18.1 允许目录名调整但依赖方向不变 | 若后续统一收敛目录，需一次性迁移并更新 workspace 与门禁 |
| SKEL-ADR-002 | 宿主采用 Pages Router（`pages/api` 与 pages 页面） | 任务书 Phase 5/6 明确 pages 路径；设计文档未冻结路由类型 | 若改为 App Router，需重写路由骨架与探针路径，属破坏性变更 |
| SKEL-ADR-003 | 路由登记口径为 P0-01 闭包的 87 条 | 设计文档 A23/ACC-API-009；12.8.1 写 84 条、A8 表 86 行存在历史计数差异 | P2-08 修正后重新生成快照 |
| SKEL-ADR-004 | Mongoose 索引统一用 `defineIndex` 声明 | 设计文档 18.8；任务书 13.4 明确指定 | 需要 lint 与架构测试保证禁用 `schema.index()` / 字段级 `index/unique` |
| SKEL-ADR-005 | 仓库级跨包测试目录命名为 `test/` | 任务书第 5 节；设计文档 19.1 只定义测试分层 | Vitest 配置显式 include，避免与包内测试冲突 |
| SKEL-ADR-006 | 扩展 API 以 Next.js 原生路径 `/api/proApi/[...path]` 暴露（不使用 rewrite） | 任务书 5.4 要求二选一；设计文档 12.1 定义逻辑基路径 `/proApi/core/dataset/**` | 若必须在 URL 上暴露 `/proApi`，改用 rewrite 并同步文档与契约测试 |

## 7. Phase 0 状态

- [x] 任务书精读与章节索引
- [x] 设计文档与参照仓库识别（路径、版本、SHA/commit）
- [x] 骨架落点映射表（本文，覆盖 5/6/7/12/18/19/20 章）
- [x] 冲突与待确认清单（见 `docs/architecture/conflicts-and-open-items.md`）
- [x] README 重写提案（待用户确认，未写入仓库）
- [x] WSL 环境核对（Node/pnpm/npm/Git 与基线一致；Docker Desktop 未运行，镜像 tag 待复核）
- [x] 仓库核对（remote/branch/log/status/ls 与 14.0 基线一致）
- [x] `feat/skeleton-monorepo` 分支创建（`main` 未改动）
- [ ] `pnpm install`（必须由用户在 WSL 执行）
