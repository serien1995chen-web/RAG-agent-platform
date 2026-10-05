# API 契约（骨架版）

> 权威依据：设计文档 12.3、12.4、12.4.1、12.4.2、12.8.1、12.8.2、12.9、12.10。

## 1. 计数与产物

| 项目         | 数量                                 | 产物                                                                    |
| ------------ | ------------------------------------ | ----------------------------------------------------------------------- |
| 路由         | 87                                   | `packages/contracts/src/openapi/route-registry.data.json`               |
| DTO          | 199（198 + 派生 `ModelReference`）   | `packages/contracts/src/dataset/dto-registry.data.json` + Schema 编译器 |
| 业务错误码   | 71（501001-501071）                  | `packages/contracts/src/errors/error-catalog.data.json`                 |
| 骨架级错误码 | 501998（内部错误）、501999（未实现） | `error-catalog.ts`（不进业务矩阵，SKEL-ADR-007）                        |
| OpenAPI 3.1  | 1 份                                 | `packages/contracts/openapi/openapi.json`、`client-types.d.ts`          |

已实现的最小路由：`API-DS-001/002/003`、`API-SEARCH-001`；其余路由由分组 catch-all 返回 HTTP 501 + 501999（含匹配到的 Route ID），扩展 API 返回 501020。

## 2. 统一响应

- `ApiResponse<T>`：`code/statusText/message/messageKey/params/data/errorType/retryable/severity/requestId`，成功时 `messageKey=common.success`。
- `ApiError`：统一错误工厂生成；`statusText` 稳定等于 `messageKey`；`requestId` 同时写入 `x-request-id` 响应头。
- Zod 入参错误按路由声明的业务码映射（list→501004、create→501001、detail→501070、searchTest→501050），未声明时返回 501998。

## 3. 生成与校验

```bash
pnpm openapi:generate   # 生成 OpenAPI 3.1 + client-types.d.ts
pnpm openapi:check      # 快照一致性 + DTO/错误码闭包
pnpm test:contract      # DTO 编译、错误矩阵、路由闭包、扩展与路由匹配
```

## 4. 分页、幂等与上限

- 分页：`page` 默认 1，`limit` 默认 20/范围 1-100；`page` 与 `cursor` 互斥。
- 请求级幂等：`Idempotency-Key` 24 小时，scope 为 `teamId+method+path+key`（`@kb/dal`）。
- 请求上限来自 `DatasetRuntimeConfigSchema`（配置注入，不在代码写死产品承诺）。

## 5. 未实现语义

未实现路由与 Port 默认实现统一返回 501999（HTTP 501）；501998 仅用于未映射内部错误。两者在 `docs/adr/README.md` SKEL-ADR-007 登记，业务矩阵保持 501001-501071 冻结。
