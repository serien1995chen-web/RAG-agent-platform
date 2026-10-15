# P8 Definition of Done 报告

## 0. 元数据与结论

| 项                  | 值                                                                                |
| ------------------- | --------------------------------------------------------------------------------- |
| 阶段                | P8 测试发布                                                                       |
| 负责人              | personB                                                                           |
| 方案 ID             | `P8-personB-plan-v2`                                                              |
| 分支                | `feat/p8-personB`                                                                 |
| 基线                | `2011e3e`（personA PR #20）                                                       |
| 验收文件生成前 HEAD | `ec895db`（P8-06 已完成）                                                         |
| 设计文档            | 3.5.1，SHA-256 `09745f52977492ebdd783605d91abd031d5d6ea146ac86b1a7faa98d557851a5` |
| 结论                | 工程 DoD 证据齐备；不构成对外发布批准                                             |

## 1. 证据方法

- 契约：`pnpm openapi:check && pnpm test:contract`。
- 全量行为：本报告第 3 节分项测试与第 6 节最外层六门禁。
- 合规：`pnpm license:check`、`pnpm architecture:check`、`pnpm forbidden-files:check`。
- 产物：根 `NOTICE` 只读哈希、A 的 SBOM 生成记录、P8-04 CI release-smoke wiring。
- 残余：只登记已确认未执行或外部未提供项，不把计划写成实现。

## 2. DoD 逐条判定

| DoD                                                         | 判定                   | 证据                                                                                                |
| ----------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| 1. 需求和源内容覆盖表已更新                                 | 通过                   | `docs/acceptance/coverage-matrix.md`；`test/contract/test-matrix.test.ts`                           |
| 2. API、Port、Repository、DTO、错误和状态已实现             | 通过                   | 87/87 路由；设计基线 198 / 实测 199 DTO；71 错误码；38 Port；`pnpm openapi:check`、`test:contract`  |
| 3. 数据集合、索引、TTL、权限和审计已实现                    | 通过                   | `mongo-schemas`、`mongo-index-manager`、`s3-ttl`、`dataset-acl-repository`、`audit-usage` 集成测试  |
| 4. 正常、失败、重复、并发、故障、跨租户、恢复和对账测试通过 | 通过                   | 第 3 节分项测试与第 6 节 `pnpm test`                                                                |
| 5. OpenAPI、SBOM、许可证和变更记录已更新                    | 通过（SBOM 引用 A/CI） | `openapi:check`；NOTICE hash；`license:check`；`release-evidence.md`；`conflicts-and-open-items.md` |
| 6. 新增配置有 schema、默认值、覆盖来源和产品承诺标识        | 通过                   | `test/contract/startup-config.test.ts`；`deploy/.env.example` 非承诺 profile                        |
| 7. 无未登记索引、未授权依赖、未完成章节或仅指向源文档的引用 | 通过并保留外部残余     | `architecture:check`、`forbidden-files:check`、`license:check`；残余见第 5 节                       |

## 3. 分项测试证据

| 命令                    | 结果                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm test:integration` | 退出码 0；Turbo 20/20；service 32 文件 / 198 用例；storage 1/13；parse 1/14；dal 1/2；qa 1/5 |
| `pnpm test:tenant`      | 退出码 0；4 文件 / 13 用例                                                                   |
| `pnpm test:concurrency` | 退出码 0；2 文件 / 7 用例                                                                    |
| `pnpm test:fault`       | 退出码 0；8 文件 / 54 用例                                                                   |
| `pnpm test:e2e`         | 退出码 0；21 文件 / 113 用例                                                                 |

Compose 四个测试依赖均处于 healthy；S03 通过后按 rev4 保持到 S09 完成后再清理。

## 4. ACC 与测试追溯

| ACC / TEST ID            | 证据                                                                        |
| ------------------------ | --------------------------------------------------------------------------- |
| `ACC-TEST-001`           | `test/contract/test-matrix.test.ts`                                         |
| `ACC-TEST-002`           | `test/contract/test-matrix.test.ts`                                         |
| `ACC-TEST-003`           | `test/contract/test-matrix.test.ts`                                         |
| `ACC-TEST-004`           | `test/contract/code-standards.test.ts`；`docs/runbooks/release-evidence.md` |
| `ACC-TEST-005`           | `test/contract/release-gates.test.ts`                                       |
| `ACC-COVER-009/010`      | `test/contract/trace-rules.test.ts`                                         |
| `TEST-TRACE-001`         | `test/contract/test-matrix.test.ts`                                         |
| `TEST-TRACE-002/003/005` | `test/contract/trace-rules.test.ts`                                         |
| `TEST-TRACE-004`         | `docs/architecture/conflicts-and-open-items.md`；残余                       |

A 的 7 个契约测试作为上述证据输入，不重复造断言；详细映射见 `coverage-matrix.md`。

## 5. U-06 行为口径

rev4 的 `node -e` 只读扫描结果：

```json
{
  "implemented": 87,
  "missing": [],
  "createSkeletonHits": [],
  "emitted501999Hits": [],
  "allowedTextException": "API-VIRT-001",
  "virtualThrows501070": true,
  "skeletonCatchAlls": [
    "projects/app/src/pages/api/core/[...path].ts",
    "projects/app/src/pages/api/internal/dataset/[...path].ts"
  ]
}
```

`API-VIRT-001` 在 `virtual.ts` 中捕获上游 `501999` 后稳定抛出 `501070`；这不是已实现路由返回骨架
未实现错误。两个 catch-all 只处理未匹配路径。

## 6. 残余项与发布阻塞

| 项                                               | 状态                                              |
| ------------------------------------------------ | ------------------------------------------------- |
| V1/V2/V3/V7/V8 与 `TEST-TRACE-004`               | 残余，依赖设计原文或 Review 只读核验              |
| 12 个月弃用窗口                                  | 条件式守卫，当前 `deprecated=0`，未执行真实调用链 |
| `caniuse-lite@1.0.30001814`                      | 法务 `RELEASE BLOCKER`                            |
| `pako@1.0.11`                                    | 法务 `RELEASE BLOCKER`                            |
| `sax@1.6.1`                                      | 法务 `RELEASE BLOCKER`                            |
| U-15 husky/lint-staged                           | 未接线                                            |
| `node:22-alpine` digest                          | 待登记                                            |
| README / LICENSE                                 | 团队外置，未完成                                  |
| 外部 Provider、备份介质、容量 profile、通知/工单 | 未提供或仅 mock                                   |

`stage-closed` 不等于可对外发布。上述阻塞项不因 DoD 工程门禁通过而消失。

## 7. 最外层门禁

| 门禁                         | 退出码 | 关键输出                                                            |
| ---------------------------- | ------ | ------------------------------------------------------------------- |
| `pnpm test`                  | 0      | Turbo 20/20；tenant 4/13；concurrency 2/7；fault 8/54；e2e 21/113   |
| `pnpm build`                 | 0      | Turbo 12/12；Next.js 生产构建完成                                   |
| `pnpm openapi:check`         | 0      | 87 条路由（已实现 87 条）、199 个 DTO、71 个错误码                  |
| `pnpm architecture:check`    | 0      | 扫描 186 个 service 源文件，无禁止依赖或循环依赖                    |
| `pnpm forbidden-files:check` | 0      | 扫描 547 个文件，无 `@fastgpt-*` 或来源素材引用                     |
| `pnpm license:check`         | 0      | 12 workspace、59 catalog、236 生产组件；保留 3 条 `RELEASE BLOCKER` |

## 8. 最终结论

P8-07 的最外层六门禁均已实测通过，工程 DoD 证据成立。对外发布仍受第 6 节法务、外置治理、基础镜像 digest
和外部依赖阻塞项约束。
