# ADR 索引与骨架期决策登记

> 状态：Phase 0 产出，已落入 WSL 仓库 `~/RAG-agent-platform`（功能分支 `feat/skeleton-monorepo`）。
> 权威来源：设计文档 0.9 节（ADR-001 至 ADR-019 已冻结）。
> 设计文档版本：3.3.0（最后更新 2026-09-30）＋ P1-06 补值（2026-10-05）；SHA-256 `28DFBFBB8E2D59BAB0192A8B3E94C627FEF88C9D0D18D348F5901C84B98433BA`。
> 冻结决策未经理评审不得改写；骨架期新增决策一律标记 `proposed`。

## 1. 冻结决策（ADR-001 至 ADR-019）

| ADR     | 主题           | 最终结论                                                        | 状态   | 关联章节                |
| ------- | -------------- | --------------------------------------------------------------- | ------ | ----------------------- |
| ADR-001 | 权威输入与追溯 | 主基线 1542 行为唯一权威输入                                    | 已冻结 | 0.1、0.8、21.1-21.3、22 |
| ADR-002 | pgvector DDL   | TEXT 主键、cosine、TIMESTAMPTZ、主基线索引名                    | 已冻结 | 10.5、10.16、21.13      |
| ADR-003 | 向量租户谓词   | 所有向量查询带 teamId、datasetId、collectionId                  | 已冻结 | 7.6、10.16、13.2        |
| ADR-004 | 跨存储删除     | Mongo 先提交，S3/PG 异步清理，补偿与对账收敛                    | 已冻结 | 10.11、14.5-14.7        |
| ADR-005 | 事件失败策略   | DatasetEventPort 默认阻塞，关键回调白名单                       | 已冻结 | 7.7、12.10、14          |
| ADR-006 | retryCount     | 剩余预算；领取递减；0 为 final_error；人工恢复重置 3            | 已冻结 | 8.11、8.13、10.7        |
| ADR-007 | 图片描述与索引 | imageDescMap 与六类 Index 类型                                  | 已冻结 | 7.2.3、10.5、10.7       |
| ADR-008 | API 兼容       | 不提供 FastGPT 历史运行时别名；三个图片路径除外                 | 已冻结 | 2.6、12.9、21.8.1       |
| ADR-009 | 错误与响应     | 旧字段兼容并新增 messageKey/params/retryable/severity/requestId | 已冻结 | 12.3-12.4、21.11        |
| ADR-010 | Port 契约      | 统一完整端口契约和默认空实现                                    | 已冻结 | 7.6、21.9               |
| ADR-011 | 图片与 auto    | 图片路径兼容；auto 改写 chunk+autoIndexes；insertData q 非空    | 已冻结 | 8.2、8.7、12.9          |
| ADR-012 | TTL            | Training 7 天；图片单一绝对到期时间；正式引用后清空 TTL         | 已冻结 | 10.7、10.9、21.18       |
| ADR-013 | ACL            | dataset_acl、权限位、显式空权限、继承、Owner、CAS、迁移         | 已冻结 | 10.10、13.3-13.6        |
| ADR-014 | 运行时角色     | all/http/worker 角色与独立 leader lock                          | 已冻结 | 5.4、6.3-6.5            |
| ADR-015 | Provider 矩阵  | 仅支持 pgvector + Mongo fulltext                                | 已冻结 | 6.1、10.16、11.5        |
| ADR-016 | 唯一性         | externalFileIdNormalized 与 dedupKey 部分唯一索引               | 已冻结 | 10.4、10.5、21.13       |
| ADR-017 | 审计与用量映射 | operationLogs、usages/usage_items、tracks 与双读窗口            | 已冻结 | 10.15、15.4、21.12      |
| ADR-018 | 前端契约       | 同团队临时 key、图片上传、预览、训练状态与错误字段              | 已冻结 | 12.9、14.8、15          |
| ADR-019 | 许可证策略     | 许可证白名单与禁止素材规则                                      | 已冻结 | 6.2、18.10、20.3        |

## 2. 骨架期决策（proposed）

### SKEL-ADR-001：目录形态采用 packages/ + sdk/ + projects/app

- 状态：proposed
- 背景：设计文档 18.1 允许目录名调整，但要求依赖方向不变；任务书第 5 节指定 `packages/`、`sdk/`、`projects/app` 三块。
- 决策：库代码放 `packages/`，基础设施 SDK 放 `sdk/`，Next.js 宿主放 `projects/app/`。
- 替代方案：全部收敛到 `packages/`；单一应用包。
- 影响：`pnpm-workspace.yaml`、Turbo 任务图、门禁脚本需覆盖三块；包名保持 `@kb/*` 与目录无关。
- 升级条件：若后续决定统一目录，需一次性迁移并更新文档与门禁。

### SKEL-ADR-002：宿主采用 Pages Router

- 状态：proposed
- 背景：设计文档未冻结路由类型，仅冻结 Next.js 16.3.0 与接口分组；任务书 Phase 5/6 明确 `projects/app/src/pages/api` 与页面路径。
- 决策：骨架期采用 Pages Router，暴露 `/api/core`、`/api/admin`、`/api/internal`、`/api/proApi` 四组路由。
- 替代方案：App Router（`route.ts` + RSC）。
- 影响：探针与路由文件布局、错误中间件形态；切换成本高，属破坏性变更。
- 升级条件：架构评审确认后可转 `frozen`；若改 App Router 需重写路由骨架。

### SKEL-ADR-003：路由登记口径为 87 条

- 状态：proposed（依赖 P2-08 修正）
- 背景：设计文档 12.8.1 写 84 条（53 既有 + 31 新增），A8 表 86 行，P0-01 闭包与 ACC-API-009 写 87 条。
- 决策：骨架期契约注册表以 P0-01 的 87 条为登记口径，先登记后对账；不得静默减少登记数。
- 影响：`openapi:check` 在 P2-08 修正完成前保持红色。
- 升级条件：P2-08 完成 87 路由与错误码口径修订后转 `frozen`。

### SKEL-ADR-004：Mongoose 索引统一使用 defineIndex 声明

- 状态：proposed
- 背景：设计文档 18.8 要求「defineIndex 或等价声明」，任务书 13.4 指定 `defineIndex`。
- 决策：所有 Schema 通过 `defineIndex(schema, { key, options, deprecated })` 声明；禁用 `schema.index()` 与字段级 `index/unique`。
- 影响：需要 lint 规则与架构测试覆盖；启动只补建缺失索引，不自动删除未登记索引。

### SKEL-ADR-005：仓库级测试目录命名为 test/

- 状态：proposed
- 背景：设计文档 19.1 定义测试分层未定义仓库级目录名；任务书第 5 节指定 `test/`。
- 决策：跨包测试放 `test/{contract,e2e,fault,tenant,concurrency,helpers}`，包内测试放各包 `test/`。
- 影响：Vitest 需显式 include 路径；CI 与本地引用同一入口。

### SKEL-ADR-006：扩展 API 使用 Next.js 原生路径 /api/proApi/[...path]

- 状态：proposed
- 背景：设计文档 12.1 的逻辑基路径为 `/proApi/core/dataset/**`，而 Pages Router 原生路径带 `/api` 前缀；任务书 5.4 要求二选一并记录。
- 决策：骨架期实际暴露 `/api/proApi/[...path]`，不在 `next.config.ts` 增加 rewrite。
- 替代方案：rewrite `/proApi/:path*` 到 `/api/proApi/:path*`，对外保持无 `/api` 前缀。
- 影响：扩展契约测试直接断言 `/api/proApi/...`；若未来需对外保持设计文档路径，可通过反向代理或 rewrite 收敛，不改核心分发逻辑。
- 升级条件：Phase 5 实现扩展 API 前由架构评审确认。

### SKEL-ADR-007：骨架期未实现与内部错误使用骨架级错误码 501998 / 501999

- 状态：proposed
- 背景：设计文档 12.4/12.4.1 冻结的业务码矩阵只覆盖 501001-501071，未定义「骨架期尚未实现」的稳定语义；任务书要求未实现路由返回稳定错误而不是 200 空对象，Port 默认空实现也必须返回稳定错误。
- 决策：骨架期新增两个骨架级编码，均不属于 501001-501071 业务矩阵：
  - `SKELETON_NOT_IMPLEMENTED = 501999`、HTTP 501、`no-retry`/`warning`，messageKey `skeleton.not_implemented`，params 携带 `route`/`port`/`operation`；任一路由或 Port 实现完成时必须移除该占位。
  - `SKELETON_INTERNAL_ERROR = 501998`、HTTP 500、`manual`/`fatal`，messageKey `skeleton.internal_error`，params 携带 `operation`；仅用于未映射的未知异常，不得用于业务语义。
- 影响：OpenAPI 快照与契约测试把未实现路由登记为 501 响应；业务错误矩阵保持冻结、不新增未登记业务码。
- 替代方案：复用 501020/501022 等业务码（语义不准确，已否决）；返回 200 空对象（违反任务书与设计文档禁止伪造成功的要求，已否决）。
- 升级条件：Phase 5 起随路由实现逐步消除；Round 2 总验收时统计剩余 501999 数量并登记。

## 3. 待办与状态

- 以上 SKEL-ADR-001 至 006 均需在 Phase 0/Phase 1 评审后决定是否转 `frozen`。
- 设计文档 P1-06 补值已应用（integrity 与四个基础设施镜像 digest 已登记）；文档版本号与 A23 变更记录尚未同步，属文档治理遗留项。
