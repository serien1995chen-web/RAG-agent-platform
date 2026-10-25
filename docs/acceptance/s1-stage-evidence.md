# S1 阶段命令与测试证据

## 1. 基线

| 项目                    | 值                                                                 |
| ----------------------- | ------------------------------------------------------------------ |
| 分支                    | `feat/kb-s01-foundation`                                           |
| 基线 HEAD               | `6032ac3d2977ac957eaa5d105a80bee4c8716095`                         |
| 设计 SHA-256            | `8E5E7300C651C4FE0478B87FC3572ADD52F95C3E49C8F15700B45BB8C690A26D` |
| 任务 SHA-256            | `BEC0B58D2CC5C1B3434D5B7D54E5C0BA2F9B16354F8FD773F4A8EAA226D1DBE9` |
| Plan Revision 2 SHA-256 | `EF7BD14DE15325DD9294488D79246C2C31DD571A29FD875F4F781A161D0C40DF` |
| Coding 规则 SHA-256     | `D65CDF29C448634B32E78A720A85A69E1158001DB7C7E62067BFE0021565DE29` |
| Node / pnpm             | `v22.23.2` / `10.33.4`                                             |
| Docker / Compose        | `29.6.2` / `5.3.1`                                                 |
| 证据采集时间            | `2026-10-25T13:38:15+08:00`                                        |

依赖安装后的 lockfile SHA-256 为
`5E2312C941C61E40D66AFAFAC5C92268AADE4DE13F3E69D2CEEC1CB6387EF91B`。
SBOM 与 NOTICE 的 SHA-256 分别为
`8c9675bedc014d873bad92778753bc7659108f53b571e7d178c643a189b2a83c` 和
`d0736f8057739f1b391836cbd7657ea1f083ddf32774fe2d25fbf8c083aab025`。

## 2. 最终门禁结果

| 命令                                                 | 退出码 | 关键结果                                                           |
| ---------------------------------------------------- | -----: | ------------------------------------------------------------------ |
| `pnpm lint`                                          |      0 | ESLint 无错误                                                      |
| `pnpm format:check`                                  |      0 | Prettier 全仓通过                                                  |
| `pnpm typecheck`                                     |      0 | 12/12 workspace 通过                                               |
| `pnpm architecture:check`                            |      0 | 39 个 service 源文件、12 个 workspace 通过                         |
| `pnpm forbidden-files:check`                         |      0 | 扫描通过，禁止依赖和来源素材为 0                                   |
| `pnpm openapi:check`                                 |      0 | 92 paths、120 operations、139 schemas、runtime 46/deferred 74      |
| `pnpm knowledge:inventory`                           |      0 | 73 Capability、92/120/139/8、46/74、23 集合、4 profiles、13 queues |
| `pnpm knowledge:check-runtime`                       |      0 | runtime 46、deferred 74、交集 0、并集 120、旧 page route 0         |
| `pnpm test:unit`                                     |      0 | Turbo 20/20 tasks；OTel 12、web 18、service 7 等通过               |
| `pnpm test:contract`                                 |      0 | 2 文件 / 12 用例通过                                               |
| `pnpm test:integration`                              |      0 | Turbo 20/20 tasks；service 10、parse 14、qa 5、dal 2 等通过        |
| `pnpm test:tenant`                                   |      0 | 1 文件 / 2 用例通过                                                |
| `pnpm test:concurrency`                              |      0 | 1 文件 / 1 用例通过                                                |
| `pnpm test:fault`                                    |      0 | 2 文件 / 8 用例通过                                                |
| `pnpm test:e2e`                                      |      0 | 1 文件 / 6 用例通过                                                |
| `pnpm build`                                         |      0 | Turbo 12/12 tasks，Next.js 生产构建通过                            |
| `pnpm build:workers`                                 |      0 | Worker 产物生成，Turbo 9/9 tasks 通过                              |
| `pnpm license:check`                                 |      0 | 12 workspace、95 catalog、441 个生产闭包组件                       |
| `pnpm sbom:generate`                                 |      0 | 93 direct、1231 transitive、12 workspace、4 image components       |
| `docker compose -f deploy/docker-compose.yml config` |      0 | 7 个服务静态解析通过                                               |
| 五镜像 `docker image inspect`                        |      0 | 5/5 存在，`linux/amd64`                                            |

E2E 六项分别覆盖：

1. 真实 Mongo/Redis/PostgreSQL/MinIO 下的 runtime catalog 与 access 路径。
2. 9 页路由、console session 和 shell 可访问语义。
3. 9 页 × 360/768/1200 viewport、横向溢出、console/page error 与 axe
   serious/critical。
4. 表格列显隐、密度、移动端表格容器滚动，以及一次 409 后输入保留。
5. 语言切换不改变 route/query，刷新后保持 `en`，`html lang` 同步。
6. 删除路径、Jobs 读取和 46/46 runtime operation 覆盖。

fixture 环境使用 CI 公布的
`KB_TEST_MONGO_URI`、`KB_TEST_REDIS_URL`、`KB_TEST_PG_URL`、
`KB_TEST_S3_ENDPOINT`、`KB_TEST_S3_REGION`、`KB_TEST_S3_BUCKET`、
`KB_TEST_S3_ACCESS_KEY`、`KB_TEST_S3_SECRET_KEY` 名称；本文件不记录凭证值。

## 3. Task 覆盖

| Task     | 原子步骤   | 状态 | 主要证据                                                                               |
| -------- | ---------- | ---- | -------------------------------------------------------------------------------------- |
| `S1-T01` | `S01..S06` | PASS | 166 项账本、95 项 catalog、lockfile 安装确认、合同/许可证/架构/禁止项门禁              |
| `S1-T02` | `S01..S04` | PASS | 37 Token、单一 Provider、共享 shell/primitives、9 页三 viewport + axe                  |
| `S1-T03` | `S01..S05` | PASS | QueryClient/keys/query/mutation、TanStack Table、RHF/Zod、9 页迁移、单飞提交           |
| `S1-T04` | `S01..S04` | PASS | 完整 zh-CN/en、22 个错误映射、ProblemView、locale 持久化与 html lang                   |
| `S1-T05` | `S01..S05` | PASS | no-op/OTLP telemetry、安全日志、runtime/worker/handler/health 接线、故障降级           |
| `S1-T06` | `S01..S04` | PASS | Node/pnpm/Chromium CI、CI 上游镜像、部署五镜像 Digest、SBOM/NOTICE、应用与 worker 构建 |
| `S1-T07` | `S01..S04` | PASS | 五镜像只读证据、Compose static config、AIProxy `UNKNOWN/BLOCKED`、runbook 引用         |

## 4. 自动补跑与缺陷收敛

- 初次 E2E 因 WSL 缺 `libnspr4.so` 无法启动 Chromium；执行 Plan 指定的
  `pnpm exec playwright install --with-deps chromium` 后重跑。
- E2E 发现并修复状态徽标对比度、横向表格键盘焦点、Chakra checkbox 命中层，
  以及 TanStack Table 在语言切换时因不稳定引用导致的重复渲染。
- fault 与 E2E 在依赖容器和 CI 测试环境就绪后真实执行，无 skip、无假数据、
  无 timeout 放宽。

## 5. 发布阻塞

`pnpm license:check` 仍报告 3 个既有 `RELEASE BLOCKER`：
`caniuse-lite@1.0.30001814`、`pako@1.0.11`、`sax@1.6.1`。它们阻断对外发布，
不阻断 S1 编码门禁。AIProxy 及四个基础设施镜像的设计状态仍为 `BLOCKED`。

## 6. 未执行项

- 未执行 `pnpm openapi:generate`：S1 未修改 OpenAPI、DTO、错误、route 或
  deferred/canonical manifest；`pnpm openapi:check` 证明快照未漂移。
- 未执行聚合命令 `pnpm test`：其组成项已分别以真实环境执行并通过。
- 本地证据采集未执行 pull、push、retag、镜像 push、PR、merge 或历史改写；
  CI 运行时由 GitHub runner 拉取上述上游测试镜像。

## 7. CI Runner 延迟修正

PR #25 的首次 GitHub Actions 运行 `40167884714` 显示，`Initialize
containers` 耗时约 22.2 分钟，随后 Mongo 拉取步骤超过 9 分钟仍无进展。原因是
GitHub 托管 runner 从阿里云杭州 Registry 拉取测试依赖镜像；这不是代码编译或
测试耗时。

CI 已调整为三个并行 job：`quality`、`integration`、`e2e`，并保留最终
`verify` 聚合检查。Mongo、Redis、pgvector 使用 Docker Hub 固定版本 tag；
MinIO 因国内网络条件单独使用设计要求的阿里云 CN 镜像与固定 Digest。发布
Compose 和 release-smoke 继续使用设计要求的阿里云 Repository + Digest。Mongo
拉取增加 180 秒硬超时，所有 job 均设置总超时，避免网络异常长期占用 runner。
