# S1 镜像与部署证据

## 1. 范围与采集环境

- 阶段 / Task：S1 / S1-T07。
- 分支：`feat/kb-s01-foundation`。
- 基线：`6032ac3d2977ac957eaa5d105a80bee4c8716095`。
- 采集时间：`2026-10-25T13:38:15+08:00`。
- Docker Engine：`29.6.2`；Docker Compose：`5.3.1`。
- 本地平台：`linux/amd64`。
- 本文件是 S1 镜像与 Compose 事实的唯一来源；Runbook 只引用本文件。

## 2. 五镜像只读证据

| 镜像     | Repository:Tag                                                                 | 设计上游 Digest                                                           | 设计状态  | 本地观察 Digest                                                                               | OS / Architecture | Image ID                                                                  |
| -------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------- |
| AIProxy  | `registry.cn-hangzhou.aliyuncs.com/labring/aiproxy:v0.7.3`                     | `UNKNOWN`                                                                 | `BLOCKED` | `sha256:da8d8394634eacdcf72533953c77c1e0ca3e28920545354dd20bdaa0aaa9ee4b`（`LOCAL_OBSERVED`） | `linux` / `amd64` | `sha256:da8d8394634eacdcf72533953c77c1e0ca3e28920545354dd20bdaa0aaa9ee4b` |
| MongoDB  | `registry.cn-hangzhou.aliyuncs.com/fastgpt/mongo:5.0.32`                       | `sha256:ab12670508974afbdf3bdc7dd39a201d228a73c9c13c70a684b9eedfb063dc3e` | `BLOCKED` | 与设计 Digest 一致                                                                            | `linux` / `amd64` | `sha256:ab12670508974afbdf3bdc7dd39a201d228a73c9c13c70a684b9eedfb063dc3e` |
| Redis    | `registry.cn-hangzhou.aliyuncs.com/fastgpt/redis:7.2-alpine`                   | `sha256:2bf71743152d3ca631d358029d504fed349ea28179667acfa755dffb4b321e7c` | `BLOCKED` | 与设计 Digest 一致                                                                            | `linux` / `amd64` | `sha256:2bf71743152d3ca631d358029d504fed349ea28179667acfa755dffb4b321e7c` |
| pgvector | `registry.cn-hangzhou.aliyuncs.com/fastgpt/pgvector:0.8.0-pg15`                | `sha256:92be4ea0424cccf17003f5803d54448e2864ac27a70e6ac5d24b3d8b463c689c` | `BLOCKED` | 与设计 Digest 一致                                                                            | `linux` / `amd64` | `sha256:92be4ea0424cccf17003f5803d54448e2864ac27a70e6ac5d24b3d8b463c689c` |
| MinIO    | `registry.cn-hangzhou.aliyuncs.com/fastgpt/minio:RELEASE.2025-09-07T16-13-09Z` | `sha256:a63b19df59e6ec7c02ebba6e7a1097b7e032da7947b18db7ff67dae8e84fd44d` | `BLOCKED` | 与设计 Digest 一致                                                                            | `linux` / `amd64` | `sha256:a63b19df59e6ec7c02ebba6e7a1097b7e032da7947b18db7ff67dae8e84fd44d` |

AIProxy 的本地观察 Digest 仅证明当前机器上的镜像事实，不覆盖设计
`UNKNOWN/BLOCKED`，也不作为生产或 CI 合同值。五个镜像均未执行 pull、push 或
retag。

## 3. Compose 静态边界

`docker compose -f deploy/docker-compose.yml config` 退出码为 0。服务全集为：

| 服务         | S1 静态职责                                          |
| ------------ | ---------------------------------------------------- |
| `mongo`      | MongoDB 单节点 `rs0`，设计 Digest                    |
| `mongo-init` | 等待 Mongo 并初始化/确认 PRIMARY                     |
| `redis`      | Redis 7.2 + AOF，设计 Digest                         |
| `pgvector`   | PostgreSQL 15 + pgvector，设计 Digest                |
| `minio`      | MinIO + 持久卷，设计 Digest                          |
| `app`        | `rag-agent-platform:kb-baseline`，HTTP `/healthz`    |
| `worker`     | 同一应用镜像，健康标记 `/tmp/knowledge-worker-ready` |

- 四个基础设施服务均使用 Repository + Tag + 设计 Digest。
- `app` 与 `worker` 使用同一本地应用镜像 Tag，并依赖四个基础设施 healthy
  及 `mongo-init` 成功完成。
- `OTEL_EXPORTER_OTLP_ENDPOINT` 仅为可选透传；空值表示明确 no-op telemetry，
  不影响 readiness。
- Compose 中 AIProxy 服务计数为 0；AIProxy PostgreSQL 也未加入。
- 未新增 collector 服务。

用户明确授权后，四个测试依赖以
`docker compose ... up -d --wait --pull never mongo redis pgvector minio`
启动，退出码为 0。最终状态如下：

| 服务         | 状态           |
| ------------ | -------------- |
| `mongo`      | `Up (healthy)` |
| `redis`      | `Up (healthy)` |
| `pgvector`   | `Up (healthy)` |
| `minio`      | `Up (healthy)` |
| `mongo-init` | `Exited (0)`   |

未构建、启动或部署 Compose 的 `app`/`worker`，也未执行 `compose down`。

## 4. 命令与输出哈希

| 命令                                                                  | 退出码 | 证据 SHA-256                                                       |
| --------------------------------------------------------------------- | -----: | ------------------------------------------------------------------ |
| `docker images --digests`                                             |      0 | `c7b10fb2eb29d5475ad98cf55a4a5125c3f1fe6fe8ee2dc1ea7a0cf1a3051075` |
| 五镜像 `docker image inspect --format ...`                            |      0 | `ae49d44cbac57d952c7883096a13f067cbe092ae1b8b78c3f9d143a5d7deac4a` |
| `docker compose -f deploy/docker-compose.yml config`                  |      0 | `7e551fa8f2548c9920d9d6057d4ff4f9ecf5800b6fced68a8032f3c513265456` |
| `docker compose ... ps --format "table {{.Service}}\t{{.Status}}"`    |      0 | `17ed748be007362e36000c39a02e93b7632715225bb05437c4eca2d908b2d01a` |
| `docker compose ... ps -a --format "table {{.Service}}\t{{.Status}}"` |      0 | `0d38051ce03ecec1cf057542a5f5b1841e0e11cfc4ddbf1427e1f3509ab61b53` |

本文件不含凭证、连接串或应用 secret。

## 5. S1-T07 判定

- `ACC-DEPLOY-01`：五镜像存在，平台为 `linux/amd64`。
- `ACC-DEPLOY-02`：Mongo、Redis、pgvector、MinIO 与设计 Digest 一致；AIProxy
  保持 `UNKNOWN/BLOCKED`，本地 Digest 标记为 `LOCAL_OBSERVED`。
- `ACC-DEPLOY-03`：Compose config 成功，四个基础设施、`app`、`worker` 与
  healthcheck 边界正确。
- `ACC-DEPLOY-04`：S1 Compose 不包含 AIProxy 或 AIProxy PostgreSQL。
- `ACC-DEPLOY-05`：证据记录命令、时间、版本、退出码和输出哈希，未执行
  pull/push/retag。

镜像设计状态仍为 `BLOCKED`，本文件不构成发布批准。
