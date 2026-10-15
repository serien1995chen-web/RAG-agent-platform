# 部署 Runbook

## 1. 发布范围与镜像

- Compose 最小 Dataset 组合：自建 `app` 镜像 + mongo、redis、pgvector、minio。
- 四个运行时镜像固定为 `tag@sha256`，值以设计 §6.3 与 `docs/runbooks/release.md` 的登记表为准。
- `node:22-alpine` 是构建期基础镜像，当前保持具名 tag；digest 待用户或 CI 登记，未登记前不得对外宣称发布完成。
- 禁止使用 `latest`；Agent 不执行 `docker pull` 或 `docker compose pull`。

## 2. 构建与校验

```bash
# 由用户或 CI 执行
pnpm install --frozen-lockfile
pnpm sbom:generate
docker compose -f deploy/docker-compose.yml build app

# 只读校验
docker compose -f deploy/docker-compose.yml config
```

发布前按 `docs/runbooks/release.md` 记录 SBOM、NOTICE、许可证门禁和镜像 digest 证据。

## 3. Compose 冒烟

```bash
docker compose -f deploy/docker-compose.yml up -d
curl --fail http://127.0.0.1:3000/healthz/live
curl --fail http://127.0.0.1:3000/readyz
curl --fail http://127.0.0.1:3000/startupz
docker compose -f deploy/docker-compose.yml down -v
```

镜像构建与 Compose 冒烟由用户或 CI 执行；Agent 只执行 `docker compose config` 等只读检查。

## 4. 启动与关闭顺序

- 启动顺序：mongo、redis、pgvector、minio，再到 app。
- `app.depends_on` 保持四个 `condition: service_healthy`。
- `app.healthcheck` 探测 `/healthz/live`。
- 关闭顺序与启动顺序相反。
- OTel Collector 等平台可选组件不得写入 `app.depends_on`，缺失时 Dataset 核心能力仍可用。

## 5. 运行角色

- `APP_WORKER_MODE=all`：同进程 HTTP、Worker、Scheduler/Cron。
- `APP_WORKER_MODE=http`：只服务 HTTP，主副本监听 Change Stream。
- `APP_WORKER_MODE=worker`：只领取任务并运行 Scheduler/Cron。

## 6. 升级与回滚

1. 冻结版本、镜像 digest、SBOM 与迁移窗口。
2. 按 `docs/runbooks/release.md` 完成发布前置检查。
3. 执行迁移 dry-run，确认回滚点与验证数据点。
4. 部署新镜像并检查三个健康端点。
5. 验证完成后标记 `kept`；失败时按 `docs/runbooks/release-rollback.md` 回滚。
6. 恢复后执行引用校验与对账。

## 7. 发布边界

- `stage-closed` 不等于可对外发布。
- README/LICENSE、备份工具与介质、容量 profile、通知/工单、PDF Provider、模型网关、mock 开关和 `node:22-alpine` digest 未完成前，持续列入发布阻塞项。
