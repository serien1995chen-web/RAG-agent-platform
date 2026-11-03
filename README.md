# RAG-agent-platform

知识库服务与工作台。目标合同为 92 paths、120 operations、139 schemas；
当前运行时已注册全部 120 个 operation，并提供 18 个可操作的控制台页面。

## 当前边界

- canonical API：`/v1/knowledge/*`、`/healthz`、`/readyz`
- canonical Mongo：23 个 `knowledge_*` 集合
- canonical pgvector：768/1024/1536 `vector` 与 3072 `halfvec`
- canonical BullMQ：13 个 `knowledge-*` 队列
- 控制台通过真实 `/v1/knowledge/*` API 完成空间、来源、导入、分段、任务、
  检索、图片、权限、连接器和运营操作

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
