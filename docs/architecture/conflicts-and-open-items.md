# 冲突与待确认清单（Phase 0）

> 状态：Phase 0 输出。权威顺序为设计文档 > 任务书 > FastGPT 只读参照。
> 本轮为第一轮（Phase 0-3）；标为「阻塞」的条目需要在对应动作前由用户确认或操作。

## 1. 冲突与差异

| ID    | 类别                  | 内容                                                                                                       | 处理建议                                                                                                           | 状态           |
| ----- | --------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------- |
| C-001 | 设计文档计数          | 路由数量：12.8.1 写 84 条（53+31），附录 A8 表 86 行，12.9 与 ACC-API-009 写 87 条（53+31+3）              | 以 12.9 实际登记的 87 条为契约口径，生成注册表并逐条核对                                                           | 已按 87 条落地 |
| C-002 | 路由框架未冻结        | 任务书使用 `pages/api`；设计文档只冻结 Next.js 版本与接口分组                                              | 采用 Pages Router，登记 SKEL-ADR-002（proposed）                                                                   | 待评审         |
| C-003 | 目录形态未冻结        | 任务书要求 `packages/ + sdk/ + projects/app`；设计文档 18.1 允许调整目录名                                 | 按任务书执行，登记 SKEL-ADR-001（proposed）                                                                        | 待评审         |
| C-004 | 骨架期错误语义        | 设计文档未定义「路由/Port 尚未实现」的业务码                                                               | 采用骨架级 501999（HTTP 501，不进入业务矩阵），登记 SKEL-ADR-007（proposed）                                       | 待评审         |
| C-005 | 设计文档占位符        | 任务书 `<设计文档路径>` 与 `<FastGPT 仓库路径>` 未替换                                                     | 本会话按已核验路径执行：设计文档 SHA-256 `28DFBF...33BA`；参照仓库 `D:\Fastgpt\FastGPT` @ `83e2b803`               | 待用户确认     |
| C-006 | README 复制风险       | 现有 README 定位句与 FastGPT README 对应段落逐字相同                                                       | 使用 `docs/architecture/readme-rewrite-proposal.md` 的提案；经用户确认后再改，并建议同步 GitHub description        | 待用户确认     |
| C-007 | LICENSE               | 仓库无 LICENSE                                                                                             | 本轮不添加；如需开源由用户指定许可证类型                                                                           | 待用户决策     |
| C-008 | Docker Desktop 未运行 | `IntegratedWslDistros` 已含 `Ubuntu-22.04`，但 `docker-desktop` 发行版 Stopped，WSL 内 `docker` 命令不可用 | Phase 4 前由用户启动 Docker Desktop 并复核四个镜像 tag；不执行 pull                                                | 待用户操作     |
| C-009 | 镜像 tag 写法         | 任务书写作 `pgvector/pgvector:0.8.0-pg15`、`minio/minio:RELEASE...`；本地实际为 CN registry 全名           | Compose 已改用本地实际存在的 `registry.cn-hangzhou.aliyuncs.com/fastgpt/*` 全名与 tag，`--pull never` 启动验证通过 | 已关闭         |
| C-010 | 设计文档治理遗留      | 6.1 已补 liteparse/jieba integrity 与四个镜像 digest，但文档版本号与 A23 变更记录未同步                    | 记录为文档治理项，不阻塞骨架；后续单独提交修正                                                                     | 记录           |
| C-011 | 远端写权限            | 任务书禁止在未授权时 push / 建 PR / 改 main                                                                | 本轮只创建本地功能分支与本地 commit；push 与 PR 等待用户明确授权                                                   | 待用户授权     |
| C-012 | 依赖安装职责          | `pnpm install` 及新增/升级依赖只能由用户在 WSL 执行                                                        | Phase 1 骨架就位后暂停，由用户执行并回传结果；Codex 只运行只读门禁                                                 | 待用户操作     |
| C-013 | 派生字段              | 10.3 的 `datasets` 未登记 version，但更新 DTO 与 CAS 契约需要                                              | 已按 SKEL-ADR-008 增加 `version`（默认 1），待 P2 修订回填                                                         | proposed       |
| C-014 | 检索占位实现          | 向量/全文 Adapter 未接入时 searchTest 需要可运行语义                                                       | 使用显式降级 Port（空 citations + `stats.degraded[]`），禁止伪造完整结果；接入真实 Adapter 后删除占位              | 已实现         |
| C-015 | pg 类型声明           | 设计文档未登记 `@types/pg`                                                                                 | 使用 `packages/service/src/types/pg.d.ts` 最小本地声明（Pool/Client/QueryResult 子集）                             | 已实现         |
| C-016 | README / LICENSE      | README 重写提案与许可证类型仍未确认                                                                        | Phase 8 暂不改写 README、不添加 LICENSE；等待用户决策后执行                                                        | 待用户确认     |

## 2. 任务书与设计文档的显式差异

1. 任务书要求 `packages/service/src/modules/*` 具备 `domain/application/repository/adapter/jobs` 五层；设计文档 18.1 的示例还包含模块级 `api/`。本项目按设计文档 5.2「路由壳留在宿主」与任务书要求，把 `api/` 统一放在 `projects/app/src/pages/api`，模块内保留五层。
2. 任务书第 8.2 节 Port 清单未单列 `DeleteJobRepository`，但设计文档 7.5 的删除模块以它为关键 Repository。本项目实现任务书 37 个 Port，并补齐 `DeleteJobRepository`，合计 38 个。
3. 任务书第 13.4 节指定 `defineIndex`；设计文档 18.8 允许「defineIndex 或等价声明」。本项目采用任务书口径，并登记 SKEL-ADR-004（proposed）。
4. 设计文档 12.8.1 的 84 条与 12.9 的 87 条存在历史计数差异；以 12.9 的逐行 Route ID 为唯一登记来源（C-001）。

## 3. 需要用户确认或执行的事项（Phase 1 结束前的暂停点）

1. 在 WSL 终端执行 `cd ~/RAG-agent-platform && pnpm install`，并回传成功/失败结果（这是唯一允许的依赖安装动作）。
2. 确认 C-005 的两条权威路径与 SHA/commit。
3. 确认 C-006 的 README 重写提案与 GitHub description 同步建议。
4. 确认 C-007：继续不添加 LICENSE，或指定许可证类型。
5. 确认 C-011：是否允许本地 commit（push 与 PR 仍需单独授权）。
6. Phase 4 开始前启动 Docker Desktop，并复核四个本地镜像 tag；若缺失或 tag 不一致，请先执行 `docker pull` 或告知处理方式。
