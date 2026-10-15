# P8 覆盖矩阵

## 1. 契约规模与证据

| 维度   | 口径                                                                     | 仓库证据                                                                                                            | 承接阶段 |
| ------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | -------- |
| 路由   | 87，已实现 87                                                            | `pnpm openapi:check`；`test/contract/contracts.test.ts`；`test/contract/trace-rules.test.ts`                        | P0-P8    |
| 错误码 | 501001-501071，共 71                                                     | `test/contract/error-matrix.test.ts`；`test/contract/contracts.test.ts`                                             | P1-P8    |
| DTO    | 设计基线 198 注册表 DTO；仓库实测 199 DTO（198+1 派生 `ModelReference`） | `test/contract/dto-closure.test.ts`；`test/contract/trace-rules.test.ts`；`packages/contracts/openapi/openapi.json` | P0-P8    |
| Port   | 38 个公开 Port                                                           | `test/contract/ports.test.ts`；`test/contract/architecture.test.ts`；设计 3.5.1 §7.6                                | P1-P8    |
| 集合   | 20                                                                       | `packages/service/test/integration/mongo-schemas.test.ts`；`docs/data/mongo-collections.md`                         | P2-P7    |
| ACC    | 191                                                                      | `test/contract/test-matrix.test.ts`；`test/contract/trace-rules.test.ts`                                            | P0-P8    |

## 2. 必测类别与核心矩阵

| 类别         | 覆盖内容                                              | 主要承载                                                                                                                      | 阶段  |
| ------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----- |
| FI 故障注入  | 依赖失败、超时、SSRF、降级、TTL、删除、OTel、导入故障 | `test/fault/**`，8 文件 / 54 用例                                                                                             | P3-P8 |
| REP 重复请求 | 请求幂等、Job 幂等、删除、同步、迁移、对账            | `packages/dal/test/**`、`test/concurrency/concurrency.test.ts`、`test/e2e/data-write.test.ts`、`test/e2e/delete-jobs.test.ts` | P2-P8 |
| TEN 跨租户   | API、检索、S3、导入、Admin、Repository 团队谓词       | `test/tenant/**`，4 文件 / 13 用例；`packages/service/test/integration/tenant-scoped-repository.test.ts`                      | P2-P8 |
| MIG 迁移恢复 | dry-run、apply、resume、rollback、未知索引、备份要求  | `test/e2e/migration*.test.ts`；`packages/service/test/integration/migration-*.test.ts`                                        | P7-P8 |
| RECON 对账   | 孤儿、缺失引用、TTL、重复运行、补偿                   | `packages/service/test/integration/reconcile.test.ts`、`compensation.test.ts`、`s3-ttl.test.ts`                               | P6-P8 |

设计 §19.4/§19.4.1 的仓库可校验矩阵由 `test/contract/test-matrix.test.ts` 覆盖：

- 5 类必测类别均有非空自动化文件。
- 16 组关键设计均有至少一个可执行测试文件。
- 21 个 e2e 文件全部存在且逐文件非空，合计 113 个用例。
- `ACC-TEST-001`、`ACC-TEST-002`、`ACC-TEST-003`、`TEST-TRACE-001` 有直接断言。

## 3. 阶段承接

| 阶段  | 主要承接                                              |
| ----- | ----------------------------------------------------- |
| P0-P1 | 目录、错误、配置、日志、健康探针、Port 骨架与基础门禁 |
| P2    | Mongo/PG/S3/Redis、索引、TTL、ACL、审计与租户谓词     |
| P3    | Job、Worker、租约、幂等、恢复和并发                   |
| P4    | 导入、解析、分块、QA、图片与写入路径                  |
| P5    | 全文/向量索引、检索、融合、引用与降级                 |
| P6    | 删除、失败重试、对账、补偿与 TTL                      |
| P7    | ACL 扩展、Usage、Audit、Migration、观测与 Runbook     |
| P8    | 契约闭包、SBOM/NOTICE、全量测试、发布证据与 DoD       |

## 4. 追溯规则与 ACC / TEST 映射

| ID               | 证据                                                                        | 状态                                           |
| ---------------- | --------------------------------------------------------------------------- | ---------------------------------------------- |
| `ACC-TEST-001`   | `test/contract/test-matrix.test.ts`                                         | 已覆盖：FI/REP/TEN/MIG/RECON 非空              |
| `ACC-TEST-002`   | `test/contract/test-matrix.test.ts`                                         | 已覆盖：16 组关键设计映射                      |
| `ACC-TEST-003`   | `test/contract/test-matrix.test.ts`                                         | 已覆盖：失败、重复、并发、恢复、对账           |
| `ACC-TEST-004`   | `test/contract/code-standards.test.ts`；`docs/runbooks/release-evidence.md` | 已覆盖：环境/profile，不声明产品承诺           |
| `ACC-TEST-005`   | `test/contract/release-gates.test.ts`                                       | 已覆盖：SBOM、许可证、禁止文件、OpenAPI wiring |
| `ACC-COVER-009`  | `test/contract/trace-rules.test.ts`                                         | 已覆盖                                         |
| `ACC-COVER-010`  | `test/contract/trace-rules.test.ts`                                         | 已覆盖                                         |
| `TEST-TRACE-001` | `test/contract/test-matrix.test.ts`                                         | 已覆盖                                         |
| `TEST-TRACE-002` | `test/contract/trace-rules.test.ts`                                         | 已覆盖仓库可校验子集                           |
| `TEST-TRACE-003` | `test/contract/trace-rules.test.ts`                                         | 已覆盖仓库可校验子集                           |
| `TEST-TRACE-004` | `docs/architecture/conflicts-and-open-items.md`                             | 残余：依赖设计原文与 Review 只读核验           |
| `TEST-TRACE-005` | `test/contract/trace-rules.test.ts`                                         | 已覆盖：测试规格字段完整性                     |

A 的 7 个契约测试文件：

| 测试文件                 | 主要证据                                  |
| ------------------------ | ----------------------------------------- |
| `api-compat.test.ts`     | 条件式兼容窗口守卫；当前 `deprecated=0`   |
| `code-standards.test.ts` | ACC-CODE-001…005、V7 仓库子集、承诺词扫描 |
| `dto-closure.test.ts`    | DTO 闭包、requiredness、嵌套、route 引用  |
| `error-matrix.test.ts`   | 71 错误码、兼容性、messageKey/params      |
| `release-gates.test.ts`  | SBOM、许可证、禁止文件、Compose/CI wiring |
| `test-matrix.test.ts`    | 5 类必测、关键设计映射、e2e 113 用例      |
| `trace-rules.test.ts`    | V4/V5/V6/V9/V10/V11、ACC-COVER-009/010    |

`contracts.test.ts` 继续作为路由、DTO、错误矩阵与健康响应的基础契约证据。

## 5. 追溯规则状态

| 规则                          | 状态       | 证据                                                           |
| ----------------------------- | ---------- | -------------------------------------------------------------- |
| V4 Route ID 集合一致          | 已覆盖     | `trace-rules.test.ts`                                          |
| V5 错误码集合连续             | 已覆盖     | `trace-rules.test.ts`                                          |
| V6 每条路由至少一个业务错误码 | 已覆盖     | `trace-rules.test.ts`                                          |
| V9 route→DTO 闭包             | 已覆盖     | `trace-rules.test.ts`                                          |
| V10 requiredness              | 已覆盖     | `trace-rules.test.ts`                                          |
| V11 无匿名对象 Schema         | 已覆盖     | `trace-rules.test.ts`                                          |
| V1/V2/V3/V7/V8                | 残余       | 依赖设计原文或 Review 只读核验，不写成已执行                   |
| 12 个月弃用窗口               | 条件式残余 | `api-compat.test.ts` 当前 `deprecated=0`，未执行真实弃用调用链 |

## 6. 运维与迁移验收

`ACC-OPS-001…005`、`ACC-MIG-001…008` 与 `TEST-OPS-RUNBOOK-001` 的逐条证据、mock/real 边界和真实恢复残余见
`docs/runbooks/release-evidence.md` 第 9 节。

## 7. 残余项

- V1/V2/V3/V7/V8 与 `TEST-TRACE-004` 仍为残余。
- 3 条法务 `RELEASE BLOCKER`、U-15 未接线、`node:22-alpine` digest 待办、README/LICENSE 团队外置未完成。
- 真实模型网关、PDF Provider、通知/工单、备份介质和容量 profile 未提供。
- `stage-closed` 不等于可对外发布。
