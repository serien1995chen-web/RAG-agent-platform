# FastGPT 知识库导入差异修复复验记录

> 复验日期：2026-11-26  
> 分支：`codex/kb-import-parity-audit-20261126`  
> 基线报告：`FastGPT知识库导入交互差异验收报告-20261126.md`  
> 行为基线：FastGPT Cloud 实际页面、`D:\FastGPT\FastGPT` 源码快照

## 结论

原验收报告的 11 项差异均已完成修复或归因修正，本轮复验通过。

| 问题 ID            | 修复结果                                                                          |
| ------------------ | --------------------------------------------------------------------------------- |
| IMPORT-NAV-001     | 四步页面移除独立导入页头；首步顶部为“退出”，后续为“上一步”，第四步为“确认上传”。  |
| IMPORT-DIR-001     | 删除“目标目录”选择器，上传、预览和提交只继承路由当前目录。                        |
| IMPORT-INDEX-001   | 关闭补充索引不再清空标题索引，标题索引不依赖文本模型。                            |
| IMPORT-INDEX-002   | 问答对模式只显示标题索引和分块处理参数。                                          |
| IMPORT-INDEX-003   | 标题只在最终 embedding 输入中生效；Segment、问答正文和全文索引保持原内容。        |
| IMPORT-PREVIEW-001 | 页面受视口约束，文件列表与分块区域独立滚动。                                      |
| IMPORT-PREVIEW-002 | H1/H2/H3 计算样式为 `28/24/20px`、`700`，并补齐 Markdown 排版。                   |
| IMPORT-PREVIEW-003 | “下一步”固定在首屏右下角，无需滚动整页。                                          |
| IMPORT-CONFIRM-001 | 确认上传页展示“来源名/状态/操作”表格和逐项状态。                                  |
| IMPORT-CONFIRM-002 | 本地文件逐来源真实创建；部分失败只重试未完成项，全部成功后提示并返回目录。        |
| IMPORT-PARSE-001   | Markdown 标题与代码边界和 FastGPT 对齐，验收文件默认生成 4 个分块并重复标题路径。 |

## 关键度量

| 视口     | 页面高度    | 页面滚动    | 分块容器             | 结果 |
| -------- | ----------- | ----------- | -------------------- | ---- |
| 1440×900 | `900/900`   | `scrollY=0` | `554/1969`，内部滚动 | 通过 |
| 811×1253 | `1253/1253` | `scrollY=0` | `903/2530`，内部滚动 | 通过 |

- 验收文件在两端均为 4 个分块。
- 确认页初始状态为“等待中”，按钮为“共 1 个文件 | 开始上传”。
- 逐来源失败场景中，已完成来源保持“完成”，失败来源显示“错误”，再次上传只发送失败来源。

## 自动化验证

- `pnpm test:unit`：22 个任务全部通过。
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`：通过。
- `pnpm build`、`pnpm build:workers`：通过。
- `test/e2e/kb-import-parity-audit.test.ts`：2/2 通过。
- `test/e2e/kb-create-import-acceptance.test.ts`：20/20 通过。
- `test/e2e/s8-image-deep-page.test.ts`：5/5 通过。
- `test/e2e/kb-b06a-upload-source.test.ts`：9/9 通过；使用独立 Redis DB `14`，避免与 3010 常驻 Worker 共用同名队列。

## 证据

- `step1-project-1440.*`：首步与顶部导航。
- `step2-project-chunk-1440.*`：分块模式的索引设置。
- `step2-project-qa-1440.*`：问答对模式条件渲染。
- `step3-project-preview-{1440,1200,811}.*`：分块预览、滚动和 Markdown 层级。
- `step4-project-confirm-1200.*`：确认上传表。
- `step4-project-partial-retry-1200.*`：部分失败和继续上传。
- `browser-evidence.json`：DOM 观测、网络请求和控制台错误。
- 每个 PNG 均有对应 `.sha256`。

## 未执行项

- 未修改历史 Source 或自动重新分块；新规则只作用于之后的导入、重训练和新建索引任务。
- 未提交、推送、创建 PR、合并或部署。
