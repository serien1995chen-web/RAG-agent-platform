# 冲突与待确认清单（P8）

> 状态：P8 当前治理清单。权威来源为设计文档 3.5.1（SHA-256
> `09745f52977492ebdd783605d91abd031d5d6ea146ac86b1a7faa98d557851a5`）与任务拆解文档。
> 本清单只记录当前结论、显式未决和发布阻塞，不重新打开已关闭 U 项。

## 1. 冲突与差异

| ID    | 类别             | 内容                                                | 当前处理                                                                                               | 状态                     |
| ----- | ---------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------ |
| C-001 | 设计文档计数     | 历史路由数 84/86/87 并存                            | `route-registry.data.json`、OpenAPI 与契约测试统一为 87/87；PR #20 / `2011e3e` 已实现                  | 已关闭                   |
| C-002 | 路由框架未冻结   | 任务书使用 `pages/api`；设计文档已冻结 Pages Router | Pages Router 与 `projects/app/src/pages/api/**` 已落地；SKEL-ADR-002 保留为骨架边界                    | 已关闭（当前实现已收口） |
| C-003 | 目录形态未冻结   | 任务书要求 `packages/ + sdk/ + projects/app`        | 目录形态已按任务书落地；SKEL-ADR-001 保留为架构边界                                                    | 已关闭（当前实现已收口） |
| C-004 | 骨架期错误语义   | `501999` 不在 501001-501071 业务矩阵                | 仅作为未匹配路径的两个 catch-all 兜底；已实现路径 501999 计数由 P8-07 结算                             | 边界保留                 |
| C-005 | 设计文档占位符   | 任务书历史占位路径已不再作为执行输入                | 当前只引用设计 3.5.1 的 SHA-256 前缀 `09745f...51a5`；不保留参照仓库路径                               | 已关闭                   |
| C-006 | README 复制风险  | 现有 README 定位句与来源项目段落存在复制风险        | README 由团队外置修改；Agent 不改 README；未完成前阻止对外发布                                         | 外置团队 / 未完成        |
| C-007 | LICENSE          | 仓库当前无 LICENSE                                  | LICENSE 类型由团队决策；Agent 不添加；未完成前阻止对外发布                                             | 外置团队 / 未完成        |
| C-008 | Docker 环境      | 历史 Docker Desktop 未运行问题                      | U-11 已于 2026-10-06 只读验证；P8-05 本地 Compose 启动、健康检查与清理实测通过                         | 已关闭                   |
| C-009 | 镜像 tag 写法    | 历史短名 tag 与设计登记的 CN registry 全名不一致    | 四个运行时镜像已锁定设计 §6.3 的 CN registry 全名与 digest；无 `latest`                                | 已关闭                   |
| C-010 | 设计文档治理遗留 | 历史版本号与 A23 变更记录未同步                     | 设计 3.5.1 已同步版本、修订记录、DTO 口径与 Port 澄清                                                  | 已关闭                   |
| C-011 | 远端写权限       | Agent 不得自行 push、建 PR、合并或改写远端历史      | 长期生效的 Agent 边界；推送、PR 与合并仅由用户执行                                                     | 边界保留                 |
| C-012 | 依赖安装职责     | `pnpm install/add/update/remove` 只能由用户执行     | 长期生效的 Agent 边界；P8 未新增依赖                                                                   | 边界保留                 |
| C-013 | 派生字段         | `datasets.version` 历史上未登记                     | 设计 3.5.1 §10.3 已登记为项目级 CAS 扩展；Schema、Repository 与 CAS 测试均已落地                       | 已关闭                   |
| C-014 | 检索占位实现     | 历史上向量/全文 Adapter 未接入时存在占位语义        | P5 已由真实 `DatasetSearchAdapter`、全文与向量存储实现替换；降级 Port 只在依赖不可用时保留明确降级     | 已关闭                   |
| C-015 | pg 类型声明      | 设计未登记 `@types/pg`                              | 继续保留 `packages/service/src/types/pg.d.ts` 最小本地声明（Pool/Client/QueryResult 子集），不新增依赖 | 边界保留                 |
| C-016 | README / LICENSE | README 重写提案与许可证类型仍未确认                 | 与 C-006/C-007 同一状态：团队外置、未完成；Agent 只做只读复核，不执行改写或添加                        | 外置团队 / 未完成        |

## 2. 设计已登记的镜像来源例外（含 digest 锁定）

- 设计 §6.3 已登记 `registry.cn-hangzhou.aliyuncs.com/fastgpt/*` 作为四个运行时镜像的 CN registry 来源，并给出 linux/amd64 digest。
- 本项目的 Compose 服务结构、环境变量名、默认值与启动/关闭顺序均为自研；没有复制来源项目部署文件、变量或品牌素材。
- D7-A 的 digest 锁定属于设计已登记的来源例外，不是引用未登记依赖；运行时不使用官方短名 tag，也不使用 `latest`。
- `node:22-alpine` 是构建期基础镜像，当前保持具名 tag；digest 未登记，必须继续列为发布阻塞项。

## 3. 当前文档、外部依赖与 Agent 边界

### 3.1 README 与 LICENSE

- README 由团队修改；`docs/architecture/readme-rewrite-proposal.md` 只读参考。
- LICENSE 类型由团队决策；当前未添加。
- 在团队完成前，README/LICENSE 均记为未完成，并阻止对外发布。

### 3.2 U-22「MD」术语

U-22 仍记为待设计负责人确认。P7-01 已按 ACL/Manage 扩展实现，不新增 MD 子系统；P8-06 只登记该未决，不阻塞仓库测试与 Review。

### 3.3 发布阻塞项引用

以下 3 条法务 `RELEASE BLOCKER` 原样引用 `docs/runbooks/release.md`；它们阻断对外发布，不阻断 CI：

| 依赖                        | 许可证        | 父链                                                    |
| --------------------------- | ------------- | ------------------------------------------------------- |
| `caniuse-lite@1.0.30001814` | CC-BY-4.0     | `projects/app → next@16.3.0 → caniuse-lite`             |
| `pako@1.0.11`               | MIT AND Zlib  | `packages/parse → mammoth@1.11.0 → jszip@3.10.2 → pako` |
| `sax@1.6.1`                 | BlueOak-1.0.0 | `sdk/storage → minio@8.0.7 → xml2js@0.6.2 → sax`        |

U-15 husky/lint-staged 仍为 `未接线`；真实备份工具与介质、容量 profile、通知/工单、PDF Provider、模型网关和 mock 开关仍需外部提供或确认。

### 3.4 Agent 当前边界

- 不执行 `pnpm install/add/update/remove`，不执行 `docker pull`、push、创建 PR、合并或部署。
- P8-05 已获 Plan rev2 明确授权，仅在本地启动/停止四个测试依赖并运行 `pnpm test`；该授权不扩展到发布镜像构建或部署。
- P8 未关闭前不得开始下一阶段；`stage-closed` 只表示 A/B 两个 PR 均合并，不等于可对外发布。
