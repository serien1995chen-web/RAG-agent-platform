# 扩展点（非 Dataset 模块）

> 权威依据：设计文档 2.7、2.8、5.7、9.1-9.4；SKEL-ADR-006。

## 1. 四个扩展点

| 扩展        | 契约文件                                                           | 首期实现                                                                                  | 未启用语义                          |
| ----------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------- |
| identity    | `projects/app/src/extensions/identity/dev-identity.provider.ts`    | 仅 development/test 提供固定主体（`KB_DEV_TEAM_ID`/`KB_DEV_TMB_ID`，必须为合法 ObjectId） | 501020 `dataset.extension.disabled` |
| agent       | `projects/app/src/extensions/agent/agent.extension.ts`             | 注册 + 关闭                                                                               | 501020                              |
| application | `projects/app/src/extensions/application/application.extension.ts` | 注册 + 关闭                                                                               | 501020                              |
| publish     | `projects/app/src/extensions/publish/publish.extension.ts`         | 注册 + 关闭                                                                               | 501020                              |

## 2. 注册表语义

- `ExtensionRegistry.register/get/require/isEnabled/describe`，落点 `projects/app/src/extensions/registry.ts`。
- `require(id)` 在未启用时抛稳定错误 501020，禁止回退到猜测实现。
- 核心 Dataset 路由不依赖任何扩展启用；identity 未启用时核心路由返回 501020，启用后正常工作（ACC-ARCH-004）。
- 扩展只能通过公开 Port / 扩展 API 访问核心数据，必须携带调用者 `teamId`、`tmbId` 与权限上下文。

## 3. 扩展 API 路径

- 逻辑基路径：`/proApi/core/dataset/**`（设计文档 12.1）。
- 实际暴露：Next.js Pages Router 原生 `/api/proApi/[...path]`，不在 `next.config.ts` 做 rewrite（SKEL-ADR-006，proposed）。
- 当前响应：HTTP 400 + 501020，`params.extension` 为匹配到的 Route ID（未匹配时为 `proApi`）。

## 4. 契约测试

- `test/contract/extensions.test.ts`：dev/prod identity 开关、三个扩展未启用稳定错误、扩展全关闭时 Dataset 核心可用。
- `test/contract/route-matcher.test.ts`：12.9 注册表匹配与具体路由优先于扩展 catch-all。
