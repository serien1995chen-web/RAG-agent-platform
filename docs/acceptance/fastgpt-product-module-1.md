# FastGPT 产品化前端模块一验收记录

日期：2026-11-09

分支：`feat/kb-fastgpt-product-ui`

## 范围

- 新路由 `/dataset/list`、`/dataset/detail`。
- FastGPT 视觉令牌、64px 桌面导航、页面容器和通用组件。
- 我的知识库根目录与文件夹目录。
- 搜索、类型/创建者筛选、排序和分页展示。
- 通用知识库、文件夹、API 文件库、飞书、语雀和钉钉创建入口。
- 编辑、移动、导出、删除、拖放移动、批量移动/删除和权限入口。
- 旧 `/spaces/*` 路由兼容重定向；旧页面和全局 demo 外壳已退出。

网站知识库不在本模块范围内。

## 数据与状态

- 页面业务数据全部来自 `/v1/knowledge/*`。
- 写操作使用真实幂等键、版本号和 CAS 语义。
- 批量结果直接消费合同中的 `requested/succeeded/failed/items`。
- 长任务、权限和错误不从本地模拟成功。
- 现有 API 不提供服务端目录过滤、名称搜索和创建者显示名，模块一通过真实分页数据做展示层筛选；创建者暂显示 `ownershipMemberId`，没有补造人员信息。
- 现有 `KnowledgeSpace` 没有知识库类型字段；新建商业来源通过显式 `iconKey` 记录来源类型，历史未知值按“通用知识库”展示，后续模块需由后端补正式类型字段。

## 自动化结果

- `pnpm --filter @kb/web typecheck`：通过。
- `pnpm --filter @kb/web lint`：通过。
- `pnpm --filter @kb/web test:unit`：模块二完成后当前为 21 个测试文件、82 个测试通过。
- `pnpm --filter @kb/app typecheck`：通过。
- `pnpm --filter @kb/app lint`：通过。
- `pnpm --filter @kb/app build`：通过。
- `pnpm openapi:check`：通过，92 paths、120 operations、139 schemas。
- `pnpm knowledge:inventory`：通过。
- `pnpm knowledge:check-runtime`：通过，runtime 120、deferred 0、旧 page route 0。
- `test/e2e/fastgpt-product-list.test.ts`：真实 Mongo、Redis、PgVector、MinIO 环境下通过；覆盖真实列表、无网站入口、文件夹进入、权限弹窗、搜索空态、批量删除、创建、详情跳转和删除。
- E2E 使用 Axe 检查，serious/critical 为 0；1440px、1200px、900px 无横向溢出。

截图：`test-results/fastgpt-product-module1/dataset-list-folder-1440.png`。
