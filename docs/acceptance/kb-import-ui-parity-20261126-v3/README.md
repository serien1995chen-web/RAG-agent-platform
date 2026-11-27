# FastGPT 知识库四步导入交互修复报告 v3

> 复验日期：2026-11-26  
> 分支：`codex/kb-import-parity-audit-20261126`  
> 基线提交：`c1b752032de802e52ef789e994114edf4d4639a6` + 当前工作树  
> 权威行为：`D:\FastGPT\FastGPT` 当前源码与 FastGPT Cloud 当前实机  
> 结论：**v2 报告中的全部 P0/P1 问题关闭，真实模型链路复验通过**

## 1. 问题关闭矩阵

| 问题 ID                    | 级别     | 复验结果                                                                                                                                 |
| -------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `BE-PARAM-QA-PAYLOAD-001`  | P0       | 关闭。QA 按段落模式会提交 `paragraphChunkAIMode`、`paragraphChunkDeep`、`paragraphChunkMinSize`。                                        |
| `BE-QA-PROMPT-001`         | P0       | 关闭。默认引导词、固定 `<Context>` 格式、问答输出格式与每块最多 50 条统一使用共享常量。                                                  |
| `UI-IMPORT-LAYOUT-001`     | P1       | 关闭。步骤条 900px、参数区 640px、上传/预览/确认使用导入内容全宽。                                                                       |
| `UI-IMPORT-UPLOADROW-001`  | P1       | 关闭。进入参数设置后不再显示上传完成文件条，上传状态仍保留。                                                                             |
| `UI-PARAM-GUIDANCE-001`    | P1       | 关闭。补充三项段落识别说明、范围、步进及 FastGPT 业务文案。                                                                              |
| `UI-PARAM-DELIMITER-001`   | P1       | 关闭。提供全部预设分隔符，仅“自定义”显示输入框。                                                                                         |
| `UI-QA-PROMPT-ENTRY-001`   | P1       | 关闭。显示“QA 拆分引导词”、真实默认值、Hover/键盘入口和固定响应格式。                                                                    |
| `UI-CONFIRM-LAYOUT-001`    | P1       | 关闭。确认表全宽，列宽约 57%/25%/18%，表头 48px 并使用浅色背景和圆角。                                                                   |
| `UI-PREVIEW-EMPTY-GAP-001` | P1       | 关闭。本地/图片预览移除重复摘要节点；未选择文件时双栏预览直接位于步骤条下方，不再被推到页面底部。                                        |
| `UI-PARAM-INDEX-001`       | 部分修复 | 关闭。按真实模型 `maxToken` 动态提供 10 项；已补齐真实 Qwen Embedding 的 4096/512 元数据，并对旧数据库模型设置做缺失 limits 的就读合并。 |

## 2. 实测结果

| 项目                  |                                            修复后 |
| --------------------- | ------------------------------------------------: |
| 1440 视口步骤条       |                                           `900px` |
| 1440 视口参数区       |                                           `640px` |
| 1440 视口导入页内边距 |                                       `20px 36px` |
| 1440 视口预览         |                          左右等宽，全部占满内容区 |
| 1440 视口分块滚动     |                        内部滚动，页面 `scrollY=0` |
| 1440 未选文件预览     | `y=143px`、高 `672px`，左右各 `636px`，无前置空白 |
| 1200 视口确认表       |                     全宽 `1034px`，等于主内容宽度 |
| 确认表头              |                   `48px`，浅色背景，左右 8px 圆角 |
| QA 参数请求           |            包含三项段落参数和默认 50 条 QA 引导词 |
| 索引候选              |     `64/128/256/512/768/1024/1536/2048/3072/4096` |
| 浏览器控制台错误      |                                               `0` |

## 3. 真实模型业务链路

- 真实 DeepSeek/LLM 成功执行 QA 模式“强制处理”段落增强。
- 实际发送给模型的 Prompt 包含默认引导词、`<Context>{{text}}</Context>` 固定格式和“最多提出 50 个问题”。
- 直接 QA 链路返回 10 个可解析问答对，未触发回退。
- 完整 UI 导入任务使用真实 LLM 和真实 Qwen Embedding，最终 Source 状态为 `ready`。
- 最终复验任务生成 10 个真实问答 Segment，全部包含非空问题和答案。

## 4. 自动化结果

| 检查                                  | 结果                                                           |
| ------------------------------------- | -------------------------------------------------------------- |
| `pnpm test:unit`                      | 22 个 Turbo 任务通过                                           |
| Service integration                   | 53 个测试文件、386 个测试通过                                  |
| v3 UI 审计 E2E                        | 1/1 通过，差异集合为空                                         |
| 既有导入/上传 E2E                     | 11/11 通过                                                     |
| 真实 Provider QA/段落测试             | 3/3 通过                                                       |
| 真实模型 UI 导入 E2E                  | 1/1 通过                                                       |
| `pnpm typecheck`                      | 12 个包通过                                                    |
| `pnpm lint`                           | 通过                                                           |
| `pnpm format:check`                   | 通过                                                           |
| `pnpm --filter @kb/app build`         | 通过                                                           |
| `pnpm --filter @kb/app build:workers` | 通过                                                           |
| OpenAPI/运行时门禁                    | 97 paths、126 operations、146 schemas、126 runtime、0 deferred |

## 5. 证据

- `project-step*.png`、`*.metrics.json`、`*.sha256`：三视口页面和计算样式。
- `project-step3-preview-unselected-1440.*`：未选择文件时的顶部双栏空态及几何数据。
- `browser-evidence.json`：差异集合、网络请求、QA Payload 和控制台错误。
- `kb-import-paragraph-real.json`：真实段落增强调用证据。
- `kb-import-qa-real.json`：真实 QA Prompt、50 条合同和模型用量。
- `kb-import-real-ui.json`：真实导入 Source 和 Segment 结果。
- `kb-import-real-preview.png`：真实模型导入预览。

## 6. 兼容性说明

- 新规则只作用于之后的预览、新建来源、重训练和重建，不改写历史 Source。
- 未提交、推送、合并或部署。
- FastGPT 侧只做只读核验，未创建或删除知识数据，未点击最终上传。
