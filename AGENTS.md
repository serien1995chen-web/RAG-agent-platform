# 仓库工作规范（自研）

## 权威与边界

1. 权威顺序：设计文档 > 任务书 > 只读参照仓库。参照仓库不得复制源码、函数名、注释、Prompt、目录名、部署文件、环境变量或品牌素材。
2. 禁止任何 `@fastgpt-*` / `@fastgpt-sdk/*` 运行时依赖（含 anydoc）。
3. `domain` 不得导入 mongoose/pg/ioredis/bullmq/minio/next/云 SDK；`application` 不得直接拼装存储查询；模块间通过 Port 调用。
4. Agent、登录、应用、发布渠道只做版本化扩展点，不实现业务逻辑。
5. 禁止 `websiteDataset`、爬虫、独立 OCR、独立 Worker 容器入口、Outbox/Saga/事件总线、数据库外键与 PostgreSQL RLS。

## 代码规则

1. 业务代码不得直接读取 `process.env`；唯一入口是 `packages/service/src/shared/config`。
2. 所有错误必须经统一错误工厂（`createApiError` / `createSkeletonError` / `createInternalError`），禁止 `throw new Error(...)`。
3. 所有查询必须带 `teamId` 谓词；缺少时抛稳定错误而不是返回空数组。
4. 版本更新使用 CAS；任务领取使用原子条件更新；异步 Job 先写 Mongo 事实再投递 BullMQ。
5. 每个 Mongoose Schema 必须通过 `defineIndex(schema, { key, options, deprecated })` 声明索引；禁止字段级 `index/unique` 与直接 `schema.index()`。
6. 新增字段必须同步 schema、DTO、迁移、索引、TTL、审计与测试。
7. 前端错误展示只消费 `messageKey` + `params`，不得自行拼接文案。

## 命令与门禁

- 依赖安装/升级（`pnpm install|add|update|remove`）只能由用户在 WSL 终端执行。
- 合并前必须通过：`lint`、`format:check`、`typecheck`、`architecture:check`、`openapi:check`、`forbidden-files:check`、`license:check`、`test:unit`、`test:contract`、`test:integration`、`test`、`build`。
- 修改契约后必须执行 `pnpm openapi:generate` 并评审快照差异。

## 提交纪律

- 工作在 `feat/*` 分支；禁止直接提交 `main`、force push 或改写远端历史。
- 未经用户明确授权，不得 push、创建 PR 或部署。
