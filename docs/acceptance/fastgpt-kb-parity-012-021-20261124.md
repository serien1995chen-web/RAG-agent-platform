# FastGPT 知识库 KB-PARITY-012～021 整改验收报告

> 验收时间：2026-11-24（Asia/Shanghai）
> 项目分支：`codex/kb-fastgpt-parity-001-011-20261124`
> 项目基线：`bb1168aea621039c51e7dd2e0be1d40e8e04ff49`
> 行为基准：`D:\FastGPT\FastGPT` 源码与 `https://cloud.fastgpt.cn/dataset/list`

## 结论

`KB-PARITY-012` 至 `KB-PARITY-021` 已全部完成代码整改和自动化验收。原有 `KB-PARITY-001` 至 `KB-PARITY-011` 专用 E2E 继续通过，无回归。

| 编号            | 状态 | 整改结果                                                                                     |
| --------------- | ---- | -------------------------------------------------------------------------------------------- |
| `KB-PARITY-012` | 通过 | 搜索 Loading、空结果、500 失败、重试和历史参数组合均有 E2E 覆盖                              |
| `KB-PARITY-013` | 通过 | 导入参数改为居中单列，使用文件解析设置和数据处理方式设置两个折叠分组                         |
| `KB-PARITY-014` | 通过 | 主流程隐藏解析器和凭据；移除智能入口；条件字段按模式显示；深度上限 8；索引大小按模型能力生成 |
| `KB-PARITY-015` | 通过 | 本地文件预览使用真实服务端解析与分块；双栏文件列表/分块预览；支持多文件切换和状态恢复        |
| `KB-PARITY-016` | 通过 | Info 改为知识库级定时同步开关；移除连接器管理和立即同步；调度器执行知识库级闸门              |
| `KB-PARITY-017` | 通过 | 标签管理改为约 800px 表格行编辑；1200px 无横向溢出                                           |
| `KB-PARITY-018` | 通过 | 新建标签仅提供选项、数字、日期；历史字符串标签继续兼容展示                                   |
| `KB-PARITY-019` | 通过 | 数组选项改为逐项弹层维护；支持重命名迁移、删除确认、去重和回车操作                           |
| `KB-PARITY-020` | 通过 | 文件菜单对齐为同步（仅可同步来源）、移动、重命名、权限、标签设置、删除                       |
| `KB-PARITY-021` | 通过 | 只读用户无更多按钮；菜单 Portal/fixed 定位；裁剪、Escape、方向键和焦点恢复通过               |

## 接口与持久化变更

- `POST /v1/knowledge/spaces/{spaceId}/imports/files` 支持 `dryRun=true`。预演必须且只能包含一个上传文件，不创建 Source、Segment 或 Job，不消耗配额。
- 模型列表增加可选 `limits`：`maxToken`、`defaultToken`、`maxContext`、`maxResponse`。缺失时按 FastGPT 规则回退。
- 知识库空间增加 `autoSync`；新建默认关闭，旧数据缺失字段按开启兼容，首次保存后写入明确值。
- 标签更新增加 `renames`，选项重命名与删除会在 MongoDB 事务中同步文件标签值。
- 未增加 API path/operation；合同保持 96 paths、124 operations、142 schemas。

## 专项验证

| 验证项                           | 结果                       |
| -------------------------------- | -------------------------- |
| `pnpm build`                     | 通过                       |
| `pnpm typecheck`                 | 通过，12/12 tasks          |
| `pnpm lint`                      | 通过                       |
| `pnpm format:check`              | 通过                       |
| `pnpm test:unit`                 | 通过，22/22 tasks          |
| `pnpm test:contract`             | 通过，34 files / 193 tests |
| `pnpm openapi:generate`          | 通过                       |
| `pnpm openapi:check`             | 通过                       |
| `pnpm knowledge:inventory`       | 通过                       |
| `pnpm knowledge:check-runtime`   | 通过                       |
| 标签、上传、调度集成测试         | 通过，3 files / 37 tests   |
| `fastgpt-parity-001-011.test.ts` | 通过，3/3                  |
| `fastgpt-parity-012-021.test.ts` | 通过，3/3                  |

## 证据

- E2E 截图与审计输出：`test-results/fastgpt-parity-012-021/`
- 专项测试：`test/e2e/fastgpt-parity-012-021.test.ts`
- 文件预演集成测试：`packages/service/test/integration/kb-b06a-upload-source.test.ts`
- 标签迁移与定时同步测试：`packages/service/test/integration/kb-b02-catalog-tags.test.ts`
- 调度闸门测试：`packages/service/test/integration/kb-b19-b-status-scheduler.test.ts`
- Web 单测 121/121 通过；Chunk 单测 30/30 通过。

## 说明

- 项目独有的解析器/凭据、智能切分和内部任务能力保留在后端或非知识库主流程，不从 FastGPT 对照主流程暴露。
- 原问题清单中列出的“下载原始文件、训练详情”不是当前 FastGPT 文件菜单项；下载保留在预览/数据详情，训练详情由状态入口进入。
- 本次 E2E 使用隔离知识库、真实本地 MongoDB/Redis/PostgreSQL/MinIO 和 Mock 模型/OCR/连接器。真实第三方 OCR 与连接器凭证联调仍由既有 Provider 验证流程负责。
