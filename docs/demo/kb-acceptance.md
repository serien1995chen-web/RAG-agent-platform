# 知识库验收平台（/demo/kb）

选定 anchor：**Swiss 验收台账**。白底、发丝线、单一信号橙 `#FF4F00`、等宽数字。
不选 SaaS 仪表盘：这里要回答的是"刚才发生了什么、证据在哪"，不是"产品有多强"。
标志性交互是右侧 **Run Spine**：每次 API 调用一条编号记录，失败左侧 3px 橙线，点开即见请求/响应/requestId。
版式：左侧 240px 导航 + 12 列主区（最大 1440px）+ 右侧 320px 可折叠脊柱；移动端两者改为抽屉。
字体：系统无衬线；仅 ID / code / requestId / JSON 用等宽栈。圆角 4–6px，无阴影、无渐变。
数字一律 `tabular-nums`；状态用"文字 + 色块"双编码，不靠颜色单独表意。

---

## 1. 定位

这是一个**验收工具**，不是产品页面。它只做知识库（Dataset）模块，把真实 API 的每次调用留成可复核的证据，
并让失败的调用一键变成缺陷记录。

## 2. 启动

```bash
# 仓库根目录
bash scripts/demo-up.sh
# 输出形如：http://localhost:3200/demo/kb
```

脚本会：

1. 用独立 compose project `kb-demo` 启动 Mongo（单节点副本集）、Redis、pgvector、MinIO；
2. 写入未跟踪的 `.env.local`（开发态身份、`APP_WORKER_MODE=all`）；
3. 启动 `@kb/app` 并等待 `/api/readyz`、`/api/startupz` 通过；
4. 打印实际 URL。

手工步骤（脚本失败时）：

```bash
docker compose -f deploy/demo/compose.demo.yml -p kb-demo up -d
docker compose -f deploy/demo/compose.demo.yml -p kb-demo up mongo-init   # 初始化副本集
cp deploy/demo/.env.example projects/app/.env.local   # 按需改端口/身份
pnpm --filter @kb/app dev -- -p 3200
```

## 3. 页面

| 路由                            | 作用                                                        |
| ------------------------------- | ----------------------------------------------------------- |
| `/demo/kb`                      | 概览：健康、规模、本次会话统计、最近一次运行                |
| `/demo/kb/datasets`             | 知识库列表：新建、搜索、打开、删除                          |
| `/demo/kb/datasets/[datasetId]` | 详情：概览/集合/数据/检索/训练/删除/标签/权限/导入导出/文件 |
| `/demo/kb/runs`                 | 验收场景：S1–S8 一键执行、逐步留证、导出                    |
| `/demo/kb/coverage`             | 87 条路由的触达矩阵                                         |
| `/demo/kb/defects`              | 缺陷记录与导出                                              |
| `/demo/kb/runtime`              | 基线 commit、身份、健康、环境                               |

## 4. 场景

| ID  | 名称                                             | 状态                                   |
| --- | ------------------------------------------------ | -------------------------------------- |
| S1  | 空库生命周期（建库→详情→删除→删除任务）          | 可执行                                 |
| S2  | 文本导入到检索（建库→建文本集合→轮询→数据→检索） | 可执行                                 |
| S3  | 直接插入与批量推送                               | 可执行                                 |
| S4  | 删除与失败重试                                   | 可执行                                 |
| S5  | 集合与标签/路径                                  | 可执行（依赖后端支持度）               |
| S6  | 文件与图片                                       | 部分（依赖 MinIO + 图片处理 Port）     |
| S7  | 权限与继承                                       | 只读为主（单身份环境无法造第二协作者） |
| S8  | 导入导出                                         | 可执行                                 |

## 5. 已知限制

- 开发态固定身份（`dev-identity`），无法构造第二个租户做真实越权测试；跨租户仅能做"非法 ID"探测。
- `imageTrainingProcessor` 仍是 ADR-010 默认空实现，图片集合可创建，但单图处理会返回 `501999`。
- Embedding 未配置真实 Provider 时，`insertData` 返回 `501062`；场景会如实记录，不伪造通过。
- 训练轮询依赖 `APP_WORKER_MODE=all`；若 Worker 未启动，集合会停在 `running`，场景标 `blocked`。

## 6. 截图索引

见仓库外 `outputs/kb-demo-run-<date>/screenshots/`，并在 `验收总结.md` 中列出。

## 7. 约定

- demo 代码全部位于 `projects/app/src/pages/demo/**` 与 `projects/app/src/demo/**`；
- 不修改 `packages/service`、`packages/contracts`、`packages/web`、`/dataset/*` 页面；
- 不新增依赖；图标为自绘 SVG 或纯文字；
- demo 创建的 Dataset 一律 `[DEMO]` 前缀，ID 记录在 `sessionStorage`，清理只删自己登记的。
