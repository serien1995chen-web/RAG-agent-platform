# Clean-room 登记与依赖合规

> 权威依据：设计文档 2.9、6.1.8、6.1.9、18.10；任务书第 4 节。

## 1. 自研模块登记

| 登记 ID       | 参考职责        | 本项目模块      | 落点                 |
| ------------- | --------------- | --------------- | -------------------- |
| CR-REF-01     | 应用宿主        | `@kb/app`       | `projects/app`       |
| CR-REF-02     | 服务编排        | `@kb/service`   | `packages/service`   |
| CR-REF-03     | 共享类型/契约   | `@kb/contracts` | `packages/contracts` |
| CR-REF-04     | 前端架构        | `@kb/web`       | `packages/web`       |
| CR-REF-05     | 队列抽象        | `@kb/dal`       | `packages/dal`       |
| CR-REF-06     | 对象存储 SDK    | `@kb/storage`   | `sdk/storage`        |
| CR-REF-07     | 三信号可观测    | `@kb/otel`      | `sdk/otel`           |
| CR-FEATURE-04 | Parser          | `@kb/parse`     | `packages/parse`     |
| CR-FEATURE-05 | Chunk           | `@kb/chunk`     | `packages/chunk`     |
| CR-FEATURE-06 | QA              | `@kb/qa`        | `packages/qa`        |
| CR-FEATURE-07 | 检索/RRF/Rerank | `@kb/search`    | `packages/search`    |
| CR-FEATURE-08 | ACL             | `@kb/acl`       | `packages/acl`       |

## 2. 禁止事项（硬约束）

- 任何 `@fastgpt-*` / `@fastgpt-sdk/*` 运行时依赖，含 `@fastgpt-sdk/anydoc`。
- 复制来源项目源码、函数名、注释、Prompt、i18n 文案、图标、字体、图片、主题文件、部署文件、环境变量名或默认值。
- 未在设计文档 6.1 登记、且未在本文件登记用途/许可证/理由的新依赖。

## 3. 依赖策略

1. 所有第三方版本集中在 `pnpm-workspace.yaml` 的 `catalog`，包内只允许 `catalog:` 引用（`catalogMode: strict`）。
2. 新增依赖流程：更新 catalog → 在本文件登记用途、许可证、理由 → 由用户在 WSL 执行 `pnpm install` → 提交 lockfile。
3. `pg` 上游缺少类型声明，且设计文档未登记 `@types/pg`；当前使用 `packages/service/src/types/pg.d.ts` 的最小本地声明，登记为骨架期例外。

## 4. 验证证据

```bash
pnpm ls --depth 0
grep -c '@fastgpt' pnpm-lock.yaml   # 期望 0
pnpm forbidden-files:check
pnpm license:check
```
