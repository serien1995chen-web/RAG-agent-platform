# 第一轮交接说明（Phase 0 - Phase 3）

> 状态：Phase 0-3 已完成骨架落地与验证；第二轮（Phase 4-8）未开始，等待用户确认后启动。
> 本轮范围：环境核对 → 读文档 → 冻结决策 → workspace 与门禁 → 契约包 → service 分层与 Port。

## 1. 已完成范围与验证

| Phase   | 主要产出                                                                                                                                            | 验证结果                                                                                       |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Phase 0 | 环境/仓库核对、`feat/skeleton-monorepo` 分支、落点映射表、ADR 索引、冲突清单、README 重写提案                                                       | 分支已创建，`main` 未改动；映射表覆盖设计文档 5/6/7/12/18/19/20 章                             |
| Phase 1 | 根 workspace/Turbo/TS/ESLint/Prettier 配置、12 个包骨架、`check-architecture` 与 `check-forbidden-files`                                            | `pnpm lint`、`pnpm typecheck`（12/12）、`architecture:check`、`forbidden-files:check` 全部通过 |
| Phase 2 | ApiResponse/ApiError/Pagination、501001-501071 错误工厂与 `classifyRetryableError`、198+1 DTO 注册表、87 条路由注册表、OpenAPI 3.1 快照与客户端类型 | `pnpm openapi:generate`、`openapi:check`、`test:contract` 通过                                 |
| Phase 3 | 8 模块 × 5 层骨架、38 个 Port 接口与默认空实现、三条写入路径服务、五个算法包导出面、架构与 Port 契约测试                                            | `architecture:check`、`pnpm typecheck`、`test:contract`（28 用例）通过                         |

## 2. 关键计数

- workspace 包：12 个（`packages/*` 9 个、`sdk/*` 2 个、`projects/app` 1 个）。
- service 模块：8 个（knowledge-base、collection、item、index、processing、permission、delete、migration），每个模块 5 层。
- Port：38 个（任务书 37 个 + `DeleteJobRepository`）；未实现时统一返回稳定错误 501999。
- 路由注册：87 条（12.9 逐行登记；4 条最小路由标记为已实现）。
- DTO：199 个（12.8.2 的 198 行 + 派生 `ModelReference`）。
- 错误码：501001-501071 共 71 个，含 params Schema；另设骨架级 501999（不进入业务矩阵）。
- 契约测试：28 个用例（error matrix、DTO 闭包、路由闭包、架构、Port、三条写入路径、算法真值表）。

## 3. 第二轮入口条件（Phase 4 开始前必须核对）

- [x] 12 个包目录与最小 package.json 存在且可独立 typecheck。
- [x] 契约注册表（87 路由 / 199 DTO / 71 错误码）与 OpenAPI 快照存在。
- [x] 8 个模块 × 5 层骨架存在。
- [x] 7.6 节 Port 全部有接口与默认空实现（38 个）。
- [x] `test/contract/` 架构测试与 Port 契约测试可执行。
- [x] `scripts/check-architecture.mjs` 与 `scripts/check-forbidden-files.mjs` 可执行并通过。
- [ ] 用户确认权威输入路径（设计文档 SHA-256 `28DFBF...33BA`、参照仓库 `D:\Fastgpt\FastGPT` @ `83e2b803`）。
- [ ] 用户确认 README 重写提案与 LICENSE 策略。
- [ ] 用户启动 Docker Desktop（当前 WSL 内不可用）并复核四个本地镜像 tag。
- [ ] 用户确认是否推送功能分支 / 创建 PR（当前仅本地提交）。

## 4. 未决与风险

| 项                                           | 说明                                                                                            | 建议阶段                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Docker Desktop 未运行                        | WSL 内 `docker` 不可用，镜像 tag 无法复核；Phase 4 依赖真实容器                                 | Phase 4 前由用户处理                           |
| pnpm `Ignored build scripts: esbuild@0.28.2` | 安装日志提示可执行 `pnpm approve-builds`；当前 Vitest/TS 可直接运行，Phase 4 集成测试前建议复核 | Phase 4 前由用户处理                           |
| README 未改写                                | 现有文本存在与来源项目 README 逐字相同的复制风险                                                | Phase 8（经用户确认）                          |
| LICENSE 未添加                               | 任务书要求不得自行添加                                                                          | 待用户决策                                     |
| 设计文档计数差异                             | 12.8.1 的 84 条与 12.9 的 87 条存在历史差异                                                     | 已按 87 条登记，P2-08 修订后重新生成快照       |
| 骨架级 501999                                | 未实现路由/Port 的稳定占位错误                                                                  | Phase 5 起逐步消除，Round 2 总验收统计剩余数量 |
| 派生 DTO `ModelReference`                    | 12.8.2 未登记但被 `RebuildEmbeddingBody` 引用                                                   | 已在 SKEL-ADR/本文件登记，供用户评审           |

## 5. 第二轮建议起点

1. 用户启动 Docker Desktop 并复核 `mongo:5.0.32`、`redis:7.2-alpine`、`pgvector/pgvector:0.8.0-pg15`、`minio/minio:RELEASE.2025-09-07T16-13-09Z`。
2. Phase 4：`@kb/dal` / `@kb/storage` / `@kb/otel` 骨架、8 个 Mongo Schema（`defineIndex`）、pgvector DDL、三配置 Schema 与角色分流、三个健康探针。
3. Phase 5-8 按任务书顺序推进；每阶段验证通过后再进入下一阶段。
