# FastGPT 知识库 10 项整改验收报告

> 验收时间：2026-11-25（Asia/Shanghai）
> 分支：`codex/kb-fastgpt-remediation-20261125`
> 基线提交：`29956bc`
> 对照标准：`D:\FastGPT\FastGPT` 源码与 FastGPT Cloud 实际交互

## 结论

KB-001 至 KB-007、KB-EXTRA-001 至 KB-EXTRA-003 的代码、接口和自动化验收已完成。
真实 TokenDance、DeepSeek QA、TextIn 与 Doc2X 链路通过；SomArk 使用新替换的
API Key 后仍返回业务码 `1107` 鉴权失败，因此保持 `BLOCKED_PROVIDER`，没有使用
mock 冒充通过。TextIn 默认 OCR 链路、真实扫描 PDF、Source 状态和语义检索均已通过。

| 编号         | 状态             | 验收结果                                                                                      |
| ------------ | ---------------- | --------------------------------------------------------------------------------------------- |
| KB-001       | PASS             | 实时 TokenDance 目录 133 项；48 项已审批画像；创建页可选择真实文本、索引和视觉模型            |
| KB-002       | PASS             | 模型弹层 Portal/fixed、翻转与边界、独立滚动、键盘、外点关闭；1200/768/360 无裁切              |
| KB-003       | PASS             | 创建页与详情页共用 `modelsForRole`；视觉 LLM 可保存为 VLM 绑定；索引重建提示明确              |
| KB-004       | PASS             | 26 种格式、5 文件、50 MiB、格式/MIME/魔数/容器结构校验、全宽导入页和上传状态完成              |
| KB-005       | PASS             | 真实 QA 生成 5/5 条同时含问题和答案的 Segment；修复一次后无效则 Job 明确失败且不写原文冒充 QA |
| KB-006       | PASS             | 800px 多行标签表、新选项、批量维护、207 业务码和版本冲突刷新后重试完成                        |
| KB-007       | PASS（默认链路） | TextIn 扫描 PDF 真实通过；Doc2X 通过；SomArk 仍被 Provider 鉴权阻断                           |
| KB-EXTRA-001 | PASS             | Mock 模型设置只读；真实目录失败显示可重试依赖错误；真实模式不渲染 Mock 模型                   |
| KB-EXTRA-002 | PASS             | List 和 Detail DTO 均返回真实 `segmentCount`，生产链路分别显示 1、5、1                        |
| KB-EXTRA-003 | PASS             | Source、Job、Stage、上传阶段均使用业务中文字符串，未知值不再直接暴露原始枚举                  |

## 真实生产链路

使用最终 App/Worker 构建和受保护环境文件执行：

| 场景                 | 结果                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------- |
| TokenDance LLM       | `deepseek-v4.1-flash`，HTTP 200                                                           |
| TokenDance Embedding | `qwen3.7-text-embedding`，HTTP 200，维度 1024                                             |
| TokenDance Rerank    | `qwen3.7-text-rerank`，HTTP 200                                                           |
| TokenDance VLM       | `kimi-k2.5`，HTTP 200                                                                     |
| Caption Embedding    | `qwen3.7-text-embedding`，HTTP 200                                                        |
| 旧版 DOC             | `apache-poi-*.doc`，`office-oxide-wasm@0.1.8`，Source ready，1 Segment                    |
| QA 文本              | `deepseek-v4.1-flash`，5 Segment，`segmentsWithQuestionAndAnswer=5`，`fallbackUsed=false` |
| 扫描 PDF             | `textin@1`，1 页，usage `page/1`，`fallbackUsed=false`，Source ready，1 Segment           |
| Doc2X OCR            | 2 页、真实 usage、`fallbackUsed=false`                                                    |
| SomArk OCR           | `BLOCKED_PROVIDER`，`errorKind=auth`，上游业务码 `1107`；无回退                           |

完整机器可读结果见 `providers/kb-live-acceptance.json`、
`providers/t02-aiproxy.json`、`providers/b11-a-*.json` 和
`providers/b11-a2-real-qa-*.json`。

## 自动化门禁

| 门禁                           | 结果                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `pnpm test:unit`               | PASS；Web 123、Service 194、Parse 43、Search 98、Contracts 26，其余包全部通过 |
| `pnpm test:contract`           | PASS；34 files / 194 tests                                                    |
| `pnpm test:security`           | PASS；22 files / 80 tests                                                     |
| `pnpm typecheck`               | PASS；12/12 tasks                                                             |
| `pnpm lint`                    | PASS                                                                          |
| `pnpm format:check`            | PASS                                                                          |
| `pnpm openapi:check`           | PASS；97 paths / 126 operations / 146 schemas                                 |
| `pnpm architecture:check`      | PASS                                                                          |
| `pnpm knowledge:inventory`     | PASS；73 capabilities、24 MongoDB collections、13 queues                      |
| `pnpm knowledge:check-runtime` | PASS；runtime 126、deferred 0                                                 |
| `pnpm license:check`           | PASS；992 个生产 npm 组件                                                     |
| `pnpm forbidden-files:check`   | PASS；973 个文件                                                              |
| App build                      | PASS                                                                          |
| Worker build                   | PASS                                                                          |

受影响 E2E：

- `fastgpt-model-settings-remediation.test.ts`：5/5
- `fastgpt-product-detail.test.ts`：2/2
- `kb-create-import-acceptance.test.ts`：20/20
- `kb-b11-b-chunk-qa.test.ts`：3/3
- `fastgpt-parity-012-021.test.ts`：3/3

## 响应式证据

三视口为 `1200×900`、`768×1024`、`360×800`。模型弹层、导入页和标签弹层
均位于视口内；导入页横向溢出为 0。

| 截图                        | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| `model-selector-1200.png`   | `4d93f3eb854367edcc0164a60c9487b7871e72c529b0180fb3b4f14c109e51fc` |
| `import-workspace-1200.png` | `0dfc4fa2d89b6ecb51ef491bc112d6083fc812e3c2bd746ee85f44b5d69b7ede` |
| `tag-settings-1200.png`     | `af61fdcf451507c0e0e6168df708d048300ba4c3f7b0e7f37b98973942dfd070` |
| `model-selector-768.png`    | `495f28cffe7bb33a7c9d0a695771f595a6444ec9c56d07eda752bbbfeba24a56` |
| `import-workspace-768.png`  | `1f6f9358446f572c76bf8f70a51bc7a6db2cd0e7e970fd21c33c81607215e69c` |
| `tag-settings-768.png`      | `56c029fd8adbb2a3b04c42c163e255cb6932ab2b67ef2e62bf0063dbdc9fe86f` |
| `model-selector-360.png`    | `93eec29e3eb3fbb89b34b95d9b26fb9afb5974efa6105ff6bf8ade7615eb80cd` |
| `import-workspace-360.png`  | `86c9241fdba57dcdf460dbc4ea21a2be43c935a13bc389eb9665276268c7f919` |
| `tag-settings-360.png`      | `57b29071e90cf464a04b8cf7d572e311a2c6c4e39060d5b0fe04e288a8a7f287` |

几何尺寸和哈希明细见 `ui-metrics.json`，每个截图旁也保存了独立 `.sha256`。

## 安全与未决项

- 全部密钥只存在于用户目录下的 `0600` 环境文件，不进入 Git、日志、截图或证据 JSON。
- SomArk 当前 Key 仍被上游拒绝为鉴权失败；需要重新签发或确认账号/接口权限后才能闭环。
- 由于凭据曾在对话中出现，建议验收后轮换 TokenDance 和三家 OCR 凭据，并只更新受保护环境文件。
