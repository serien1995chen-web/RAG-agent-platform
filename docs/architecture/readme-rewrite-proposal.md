# README 重写提案（待用户确认）

> 状态：提案。用户确认前不得改写仓库根目录 `README.md`，不得添加 `LICENSE`。

## 1. 现状与风险

现有 `README.md` 正文（206 bytes）为：

```text
# RAG-agent-platform
是一个 AI Agent 构建平台，提供开箱即用的数据处理、模型调用等能力，同时可以通过 Flow 可视化进行工作流编排，从而实现复杂的应用场景
```

该正文与 FastGPT 仓库 README 对应段落逐字相同（仅去掉产品名），存在 `ACC-PROD-005` 与 18.10 节所述复制风险。

## 2. 建议替换正文

```markdown
# RAG-agent-platform

RAG-agent-platform 是一个面向知识库场景的自研平台工程，首期聚焦知识库领域的完整链路：
知识库（KnowledgeBase）、集合（SourceCollection）、知识条目（KnowledgeItem）、索引（KnowledgeItemIndex）、
处理任务（ProcessingJob）、集合标签（CollectionTag）与图片资产（ImageAsset）。

首期边界：

- 实现三条写入路径：来源导入、直接插入、队列推送。
- 实现检索链路：全文召回、向量召回、混合召回、融合与降级记录。
- Agent、登录、应用与发布渠道首期只提供版本化扩展点，不包含业务实现。
- 不包含网站爬取（websiteDataset）、独立 OCR、多向量库 Provider 与独立 Worker 容器。

本地启动、目录导览、工程门禁与文档索引见 `docs/`。

License：仓库当前未添加 LICENSE，许可证策略待团队决策。
```

## 3. 建议同步修改的 GitHub 仓库 description

```text
面向知识库场景的自研平台工程：知识库、集合、数据、索引、处理任务、权限与检索管线。
```

## 4. 建议 README 结构

项目定位 / 首期范围与不包含项 / 目录导览 / 本地启动 / 门禁命令 / 文档索引 / License 状态。
