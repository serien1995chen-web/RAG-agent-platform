# 本地开发 Runbook

## 1. 前置

- WSL2 Ubuntu 22.04.5；Node 22.23.2、pnpm 10.33.4、Docker Engine（Docker Desktop WSL 集成）。
- 依赖安装与升级命令只能由用户在 WSL 执行：`pnpm install`。

## 2. 启动依赖容器（镜像已本地存在，不触发 pull）

```bash
cd ~/RAG-agent-platform
docker compose -f deploy/docker-compose.yml up -d --pull never
docker compose -f deploy/docker-compose.yml ps
```

服务：mongo:5.0.32、redis:7.2-alpine、pgvector:0.8.0-pg15、minio:RELEASE.2025-09-07T16-13-09Z（CN registry 全名，与本地镜像一致）。

## 3. 配置

- 应用模板：`projects/app/.env.example`（本地 `.env.local` 为 gitignored 开发值）。
- Compose 模板：`deploy/.env.example`。
- 业务代码不得直接读取 `process.env`；统一由 `packages/service/src/shared/config` 解析。

## 4. 开发与探针

```bash
pnpm dev
curl -s http://localhost:3000/healthz/live
curl -s http://localhost:3000/readyz
curl -s http://localhost:3000/startupz
```

期望：live 200；readyz 在四个依赖健康时 200，必需依赖不可用时 503 且 `checks[].status=failed`；startupz 初始化完成 200，否则 503。

## 5. 页面

- `/dataset/list`：知识库列表与创建。
- `/dataset/detail/<datasetId>`：基础信息、集合/数据计数、搜索测试与降级阶段展示。

## 6. 门禁

```bash
pnpm lint && pnpm format:check && pnpm typecheck
pnpm architecture:check && pnpm openapi:check && pnpm forbidden-files:check && pnpm license:check
pnpm test:unit && pnpm test:contract
pnpm test:integration   # 需要容器
pnpm test && pnpm build
```

## 7. 停止

```bash
docker compose -f deploy/docker-compose.yml down
```

如需删除数据卷：`docker compose -f deploy/docker-compose.yml down -v`（不可恢复，需确认）。
