# FastGPT 知识库交互与业务一致性修复记录

> 日期：2026-11-27  
> 分支：`codex/kb-import-parity-audit-20261126`  
> 基线：`c1b752032de802e52ef789e994114edf4d4639a6` + 原有未提交工作树  
> 标准：FastGPT 源码、FastGPT Cloud、交互规范与前端设计规范  
> 结果：通过

## 结论

原验收报告中的 `KB-PARITY-001` 至 `KB-PARITY-006`、14 条专项断言已全部修复。
专项 E2E 的 `mismatches.json` 为 `[]`，浏览器控制台错误为 `[]`。

## 修复内容

| 问题                              | 修复结果                                                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件列表、目录入口和 Unicode 名称 | 删除独立“新建目录”；列头改为名称、处理模式、数据量、创建/更新时间、状态、启用、操作；对象键与展示名分离；中文原名完整保留；不再展示 Source ID |
| 状态与异常                        | 已就绪状态只读；处理中/异常打开 `712×620px` 双页签训练状态弹窗；顶部“训练异常列表”按 Source 分组并支持权限控制的重试、编辑、删除              |
| 文件元数据                        | 右栏 `320px`；按 15 个 FastGPT 字段展示真实时间和处理快照，不再出现“后端未提供”                                                               |
| 图片元数据                        | 独立 7 字段投影，不混入文件解析、分块或内部权限字段                                                                                           |
| Data 编辑                         | `800×620px`、10px 圆角、双栏等宽、32px 间距；常规/QA 模式、内容和索引区、`更新索引`、`新增`、系统索引只读均已对齐                             |
| 调整训练参数                      | 改为三步真实流程；回填原 Source 配置；按新参数生成真实预览；提交后创建新 Source 和真实 Job，并软删除旧 Source                                 |
| 全来源重训练                      | 文件、文本、网页、模板、备份、API 文件库、飞书、语雀、钉钉、图片均进入同一替换事务；保留名称、目录、标签、搜索状态、权限与连接器身份          |

## 接口与合同

- 新增 `POST /v1/knowledge/sources/{sourceId}/retrain`。
- `dryRun=true` 返回真实来源预览；普通来源返回分块结果，图片返回图片集合信息。
- `dryRun=false` 返回 `sourceId`、`previousSourceId` 和真实 `job`。
- Source DTO 增加时间、处理模式、解析配置、分块配置、原文长度和标签投影。
- 合同更新为 98 paths、127 operations、149 schemas、8 parameters；runtime 127，deferred 0。

## 测试结果

| 门禁                                                        | 结果                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| `pnpm test:unit`                                            | 22/22 tasks passed                                             |
| `pnpm test:contract`                                        | 34 files / 195 tests passed                                    |
| `pnpm test:integration`                                     | 53 files / 388 tests passed                                    |
| `pnpm test:tenant`                                          | 21 files / 59 tests passed                                     |
| `pnpm test:concurrency`                                     | 24 files / 61 tests passed                                     |
| `pnpm test:fault`                                           | 26 files / 94 tests passed                                     |
| `pnpm test:security`                                        | 22 files / 80 tests passed                                     |
| `pnpm test:e2e -- --maxWorkers=1`                           | 51 files passed, 3 files skipped；227 tests passed, 38 skipped |
| `pnpm typecheck`                                            | 12/12 tasks passed                                             |
| `pnpm format:check` / `pnpm lint`                           | passed                                                         |
| `pnpm openapi:check`                                        | passed                                                         |
| `pnpm knowledge:inventory` / `pnpm knowledge:check-runtime` | passed                                                         |
| `pnpm build` / `pnpm build:workers`                         | passed                                                         |

专项 E2E 覆盖：

- 真实上传、中文文件名、Source DTO、Data 标题和元数据。
- Collection 列头、目录入口、ready 状态只读。
- 数据集级训练异常与 Source 级训练状态双页签。
- 文件 15 字段、图片 7 字段。
- Data 常规/QA 编辑尺寸、字段和真实索引更新。
- 重训练参数回填、真实预览、新 Source ID 与旧 Source 移除。
- 1440、1200、900、360 宽度下无横向溢出，900 及以下取消双栏。

## 证据位置

截图、DOM 几何、网络请求、控制台错误、mismatch 和 SHA-256 位于：

`docs/acceptance/fastgpt-kb-interaction-parity-20261127/`

## 已知边界

- 旧版 `safeName()` 已经持久化为下划线的历史文件名无法可靠恢复，本次不进行猜测式迁移；新上传、预览和重训练均保留 Unicode 原名。
- 严格遵循 FastGPT 重训练语义：事务提交后旧 Source 立即不可见，训练结果由新 Source 承载；训练失败进入新 Source 的异常体系。
- 本轮未提交、推送、创建 PR、部署或合并。
