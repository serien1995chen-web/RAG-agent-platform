# 部署 Runbook（骨架版）

## 1. 镜像与锁定

- 依赖镜像（本地已存在）：mongo:5.0.32、redis:7.2-alpine、pgvector:0.8.0-pg15、minio:RELEASE.2025-09-07T16-13-09Z（`registry.cn-hangzhou.aliyuncs.com/fastgpt/*` 全名）。
- 应用镜像：`deploy/Dockerfile` 多阶段构建，单镜像通过 `APP_WORKER_MODE=all|http|worker` 切换角色；首期不提供独立 Worker 容器入口。
- 禁止 `latest`；发布前登记镜像 digest 与 SBOM（自建制品 CR-REV-01 digest 待构建流水线生成）。

## 2. 构建与校验

```bash
# 由用户执行（会拉取 node:22-alpine 基础镜像）
docker compose -f deploy/docker-compose.yml build app
# Codex 可执行
docker compose -f deploy/docker-compose.yml config
```

## 3. 发布前冻结

```bash
# 由用户执行
pnpm install --frozen-lockfile
# Codex 执行
pnpm lint && pnpm format:check && pnpm typecheck
pnpm architecture:check && pnpm openapi:check && pnpm forbidden-files:check && pnpm license:check
pnpm test:unit && pnpm test:contract
pnpm test:integration
pnpm test && pnpm build
pnpm sbom:generate
```

## 4. 迁移与回滚

- pgvector DDL 幂等；空库初始化与重复启动均可执行 `deploy/init/pgvector.sql`。
- Mongo 索引只补建缺失项，不自动删除未登记索引；`MONGO_DEPRECATED_INDEX_CLEANUP` 默认关闭。
- 迁移 Registry、dry-run/resume/rollback 的完整 Runbook 属于后续实现阶段（当前仅 Port 与测试占位）。

## 5. 运行角色

- `all`：Compose 首期形态，同进程 HTTP + Worker + Scheduler/Cron。
- `http`：只服务 HTTP，主副本监听 Change Stream。
- `worker`：只领取任务并运行 Scheduler/Cron。
- 多副本共享同一 Mongo/Redis 事实源；Scheduler/Cron 与 leader lock 需分布式锁（Phase 8 后续实现）。
