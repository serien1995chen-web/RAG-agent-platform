# 模块边界

## 依赖方向

```text
api -> application -> domain
application -> port <- adapter
jobs -> application
shared -> no business reverse dependency
extensions -> public port
```

`domain` 不得导入 mongoose、pg、ioredis、bullmq、minio、Next.js 或云 SDK。
`application` 不得直接拼装 Mongo、S3、PG 查询。`api` 不得直接访问 repository
实现。依赖图不得成环，不得跨模块导入内部文件。

## 包职责

| 包              | 职责                                              |
| --------------- | ------------------------------------------------- |
| `@kb/contracts` | OpenAPI、运行时/deferred registry、DTO 与错误合同 |
| `@kb/service`   | domain、application、repository、adapter、jobs    |
| `@kb/dal`       | BullMQ、Outbox 与幂等基础                         |
| `@kb/acl`       | 权限评估与继承                                    |
| `@kb/chunk`     | 切分算法                                          |
| `@kb/parse`     | 本地格式解析与 Provider 合同                      |
| `@kb/qa`        | QA 解析和校验                                     |
| `@kb/search`    | 召回、融合和排序算法                              |
| `@kb/web`       | 控制台组件、hooks、i18n、tokens                   |
| `@kb/storage`   | ObjectStore 适配                                  |
| `@kb/otel`      | trace、metric、log                                |
| `@kb/app`       | Next.js API/UI 宿主与 worker 入口                 |

## 业务模块

基座领域围绕 `catalog`、`taxonomy`、`access`、`jobs`、`operations` 组织。
旧的 `knowledge-base / collection / item / permission` Dataset 聚合不得与
新模块同时作为 canonical 业务实现存在。

## 机器门禁

`pnpm architecture:check` 检查禁止依赖、循环依赖、旧 Dataset 聚合、旧路由
和空实现模式。`pnpm knowledge:check-runtime` 检查完整合同与 46/74 运行时
子集的一致性。
