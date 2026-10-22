# RAG-agent-platform

知识库服务与工作台。当前分支实施知识库架构基座，目标合同为 92 paths、
120 operations、139 schemas；运行时只暴露 46 个已批准 operation。

## 当前边界

- canonical API：`/v1/knowledge/*`、`/healthz`、`/readyz`
- canonical Mongo：23 个 `knowledge_*` 集合
- canonical pgvector：768/1024/1536 `vector` 与 3072 `halfvec`
- canonical BullMQ：13 个 `knowledge-*` 队列
- 导入、解析、检索、连接器等未批准行为在 deferred manifest 中登记，
  不注册运行时路由，不在控制台显示为可用

本基座不代表 69 项知识库业务能力已经完成，也不代表已达到 FastGPT 完整效果。
外部 AIProxy、OCR、飞书、语雀和钉钉只提供合同与 mock，状态为
`EXTERNAL_UNVERIFIED`。

## 本地验证

```bash
pnpm openapi:check
pnpm knowledge:inventory
pnpm knowledge:check-runtime
pnpm test:contract
```

依赖安装只能由维护者在 WSL 终端执行。详细边界见
`docs/architecture/knowledge-baseline.md` 与 `docs/acceptance/`。
