# S1 依赖账本验收证据

## 基线

| 项目                    | 值                                                                 |
| ----------------------- | ------------------------------------------------------------------ |
| 阶段 / Task             | S1 / S1-T01                                                        |
| 分支                    | `feat/kb-s01-foundation`                                           |
| 基线 commit             | `6032ac3d2977ac957eaa5d105a80bee4c8716095`                         |
| 设计 SHA-256            | `8E5E7300C651C4FE0478B87FC3572ADD52F95C3E49C8F15700B45BB8C690A26D` |
| 任务 SHA-256            | `BEC0B58D2CC5C1B3434D5B7D54E5C0BA2F9B16354F8FD773F4A8EAA226D1DBE9` |
| Plan Revision 2 SHA-256 | `EF7BD14DE15325DD9294488D79246C2C31DD571A29FD875F4F781A161D0C40DF` |
| Coding 规则 SHA-256     | `D65CDF29C448634B32E78A720A85A69E1158001DB7C7E62067BFE0021565DE29` |
| 账本 SHA-256            | `0778F106D3851FBAA84AEC31B520E66FD27E384F2B4EA9B3ACB988888FB2CAE5` |
| 基线审计 SHA-256        | `C33F5131AFC3A81D0A92EB70FBD47D658954EC12838F65DEDDCB7A237DD41AE5` |
| Catalog SHA-256         | `018D215A37D37496F883B1DC085A242F5CF42EBE610BBE64F20B2E243159BE75` |
| Node / pnpm             | `v22.23.2` / `10.33.4`                                             |

## 依赖账本

- 总项数：166，名称唯一。
- 设计 17.4：164。
- 用户授权 test-only：2。
- ownerStage：S1 91、S2 13、S4 24、S5 2、S6 6、S7 21、S8 1、S10 6；S3、S9、S11 为 0。
- Source：`FASTGPT_SUPPLEMENT` 113、`PROJECT_BASELINE` 51、`USER_APPROVED_S1_BROWSER_E2E` 2。
- Scope：`RUNTIME` 124、`BUILD` 16、`TEST_ONLY` 26。
- Catalog-only 后续阶段例外：`ajv@8.17.1` 归 S4，`@llamaindex/liteparse-wasm@2.0.8` 归 S5。
- 授权 test-only：`@playwright/test@1.64.1`、`@axe-core/playwright@4.14.0`，仅位于根 devDependencies。

## 基线安装状态审计

审计数据来自 `6032ac3` 的 lockfile、catalog 和 12 个 manifest，不使用安装后的
`node_modules` 反推历史状态。

| 状态                       | 设计 164 项 |
| -------------------------- | ----------: |
| `DECLARED_INSTALLED`       |          52 |
| `DECLARED_NOT_INSTALLED`   |           5 |
| `UNDECLARED_INSTALLED`     |          15 |
| `UNDECLARED_NOT_INSTALLED` |          92 |

- 2 个 test-only 补充项初始状态均为 `UNDECLARED_NOT_INSTALLED`。
- 当前设计声明 57 项；基线已安装 67 项；仅传递依赖 15 项。
- catalog spec 与设计精确版本不一致 26 项。
- 已安装但未包含设计目标版本 10 项。
- 15 个仅传递依赖与 Plan 2.1 名单完全一致。

| 数据来源                                 | SHA-256                                                            |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `6032ac3:pnpm-lock.yaml`                 | `9A41880597EDECC7AB574C9354B669DC182EC21E7359AFCB7ABD50D982751A40` |
| `6032ac3:pnpm-workspace.yaml`            | `9568FB9428E7B16003ECB7D75157E26296478DB26609378D4FFFCA7A9D596AB9` |
| 12 个基线 manifest 的 `git ls-tree` 快照 | `2292725B51644B7171D1CB7116C0917D2F982A4CE3B2ED91740E60D8F80C3DB6` |
| `npm-dependency-audit.data.json`         | `C33F5131AFC3A81D0A92EB70FBD47D658954EC12838F65DEDDCB7A237DD41AE5` |

## 安装暂停与恢复

| 项目                    | 值                                                                 |
| ----------------------- | ------------------------------------------------------------------ |
| 安装命令                | `pnpm install`，由用户在 WSL 执行                                  |
| 安装前 lockfile SHA-256 | `9A41880597EDECC7AB574C9354B669DC182EC21E7359AFCB7ABD50D982751A40` |
| 安装后 lockfile SHA-256 | `5E2312C941C61E40D66AFAFAC5C92268AADE4DE13F3E69D2CEEC1CB6387EF91B` |
| lockfile 变化           | `12206` 行新增，`2550` 行删除                                      |
| 手工修改 lockfile       | 否                                                                 |
| 恢复点                  | `S1-T01-S05`                                                       |

安装后的 catalog 为 95 项：93 个设计包加 2 个授权 test-only 包。所有外部依赖声明均使用 `catalog:`，所有版本为设计精确版本；`@opentelemetry/instrumentation` 与 `js-yaml` 已移除。12 个 workspace 包版本均为 `0.1.0`。

## 命令证据

| 命令                                                | 退出码 | 关键输出                                                            |
| --------------------------------------------------- | -----: | ------------------------------------------------------------------- |
| `pnpm format:check`                                 |      0 | All matched files use Prettier code style                           |
| `pnpm test:contract`                                |      0 | 3 个测试文件、23 个测试通过；dependency gate 6 个正反向断言通过     |
| `pnpm license:check`                                |      0 | 12 个 workspace 包、95 个 catalog 项；实际安装版本与账本一致        |
| `pnpm architecture:check`                           |      0 | 扫描 39 个 service 源文件、12 个 workspace 包；无禁止依赖或循环依赖 |
| `pnpm forbidden-files:check`                        |      0 | 扫描 239 个文件；`@fastgpt-*` 与来源素材命中 0                      |
| `node scripts/check-licenses.mjs --dependency-only` |      0 | 166 项 ledger、166 项 audit、95 项 catalog、12 个 workspace 包      |

## Release Blocker

以下 3 项为既有 `pending-legal-review`，继续阻断发布，不阻断 S1 编码门禁：

| 包                          | 许可证          | 父链                                                           |
| --------------------------- | --------------- | -------------------------------------------------------------- |
| `caniuse-lite@1.0.30001814` | `CC-BY-4.0`     | `projects/app → next@16.3.0 → caniuse-lite@1.0.30001814`       |
| `pako@1.0.11`               | `MIT AND Zlib`  | `packages/parse → mammoth@1.11.0 → jszip@3.10.2 → pako@1.0.11` |
| `sax@1.6.1`                 | `BlueOak-1.0.0` | `sdk/storage → minio@8.0.7 → xml2js@0.6.2 → sax@1.6.1`         |

`license:check` 的 SBOM diff 在 T01 阶段为新增 840、移除 6；最终 SBOM/NOTICE 由 S1-T06 重新生成并冻结。

## 边界确认

- 未新增或修改 Capability、operation、OpenAPI、Mongo/PostgreSQL Schema、Migration 或 Queue handler。
- 未读取或复制 FastGPT 项目源码。
- Coding 未执行 `pnpm install/add/update/remove`、Docker pull/push/up/down 或 Git 历史改写。
