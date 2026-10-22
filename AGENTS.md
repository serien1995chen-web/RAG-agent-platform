# 仓库工作规范（知识库架构基座）

## 权威顺序

1. 用户在当前任务中的明确决策。
2. `KnowledgeBase-System-Design.md` 1.0.0。
3. 当前仓库源码、合同、Schema、DDL、队列和测试所反映的真实事实。
4. 历史设计与 P0-P8 任务书，仅用于解释历史。
5. FastGPT 只读参照，只用于行为消歧。

不得让历史设计、历史任务书或只读参照覆盖当前目标设计。禁止复制 FastGPT
源码、函数名、注释、Prompt、Schema 原文、目录、部署文件、页面或品牌素材。
禁止任何 `@fastgpt-*`、`@fastgpt-sdk/*` 或 `@kb-sdk/*` 依赖。

## 架构边界

1. `domain` 不得导入 mongoose、pg、ioredis、bullmq、minio、Next.js 或云 SDK。
2. `application` 通过 Port 编排用例，不得直接拼装存储查询。
3. Repository 的所有 find、update、delete、count 和 aggregate 必须强制
   `workspaceId`；缺少 TenantContext 时稳定拒绝，不得返回空结果。
4. `knowledge_*` 是唯一 canonical Mongo 集合；`knowledge-*` 是唯一 canonical
   BullMQ 队列；`/v1/knowledge/*` 与健康检查是唯一公开 API 前缀。
5. 不保留旧 Dataset alias、双读、双写、旧集合反馈、旧队列或旧数据自动迁移。
6. Agent、登录、应用和发布渠道只做版本化扩展点，不实现业务逻辑。

## 正确性与一致性

1. 业务代码不得直接读取 `process.env`；唯一入口是
   `packages/service/src/shared/config`。
2. 所有业务错误必须经统一错误工厂 `createKnowledgeError` 生成
   `KNOWLEDGE_*` 合同；禁止数字业务码、骨架占位码、not-implemented 文案和
   临时错误码。
3. 所有资源写入使用 `version` CAS。权限状态或 ACL 主体变化必须递增
   `permissionRevision` 并写审计事实。
4. Job 在 Mongo 中保存业务真相；领取、租约、心跳和提交使用
   `attemptEpoch`/fencing token。BullMQ 只负责投递。
5. 跨存储副作用的 Outbox 事件必须与业务文档、Job 在同一 Mongo 事务内创建。
   Outbox dispatcher 负责幂等投递；禁止在事务外投递或生成重复副作用。
6. 每个 Mongoose Schema 必须通过
   `defineIndex(schema, { key, options, deprecated })` 声明索引；禁止字段级
   `index/unique` 与直接调用 `schema.index()`。
7. 外部 Provider 必须使用判别联合合同，包含 timeout、错误分类、脱敏和 mock。
   真实凭证未验证时只能标记 `EXTERNAL_UNVERIFIED`，不得称为已联调。
8. 新增字段必须同步 Schema、DTO、OpenAPI、索引、TTL、审计和测试。
9. 前端错误展示只消费 `messageKey` + `params`，不得自行拼接后端错误文案。

## 合同与运行时

1. 完整目标合同固定为 92 paths、120 operations、139 schemas。
2. runtime registry 只允许 46 个已批准 operation。
3. 其余 74 个 operation 只存在于 deferred manifest；不得注册运行时路由、
   不得用占位错误伪装、不得在 UI 显示为可用。
4. 修改合同后必须执行 `pnpm openapi:generate`，再执行
   `pnpm openapi:check`、`pnpm knowledge:inventory` 和
   `pnpm knowledge:check-runtime`。

## 依赖与命令

- 依赖安装/升级（`pnpm install|add|update|remove`）只能由用户在 WSL 终端执行。
- 新增依赖时先完成 `package.json`/catalog 声明，再停止并给出准确安装命令、
  预期 lockfile 和继续指令；不得伪造 lockfile。
- 合并前必须通过验收标准中的静态门禁、真实基础设施测试、租户/并发/故障测试、
  E2E、应用与 Worker 构建以及 Compose health。

## 提交纪律

- 架构基座只使用 `feat/kb-architecture-baseline` 单一分支。
- 禁止直接提交 `main`、force push、reset 远端历史或改写历史。
- 未经用户明确授权，不得 push、创建 PR、部署或 merge。
