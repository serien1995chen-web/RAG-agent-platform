# FastGPT 产品化前端模块四验收记录

日期：2026-11-09

分支：`feat/kb-fastgpt-product-ui`

## 范围

- Search Test 文本输入、Submit、检索参数与标签过滤。
- 语义、全文、混合检索模式，Token 上限、相似度、向量权重和 ReRank 权重。
- 测试结果、耗时、分数、引用卡片、原始来源和查看 Data 入口。
- 空结果保留上一条结果并显示 Warning。
- 按知识库隔离、最多 50 条、刷新后可恢复的本地测试历史。
- 图片选择、真实上传和真实 `/search/image` 调用。
- Info 基本信息、模型绑定编辑、Source 权限总开关、协作者列表和添加/移除。
- 外部数据源连接器状态与手动同步入口。
- 1440px、1200px、900px 视觉与无障碍验证。

## 数据边界

- 搜索结果、耗时、分数、引用和降级信息完全来自 Search API。
- 搜索历史和参数保存在浏览器 localStorage，只保存真实 API 返回结果。
- 图片查询使用真实上传会话；当前测试数据没有图片索引时，后端返回 NOT_FOUND，前端展示错误且不会生成假结果。
- 模型绑定通过真实模型目录和版本 CAS 更新。
- 协作者添加和移除使用真实 API。

## 明确保留的能力缺口

- Search API 不包含查询扩展 Prompt 字段，前端明确标注未提供。
- Search API 不包含选择具体 ReRank 模型字段，只支持启用与权重。
- Collaborator DTO 没有提供更新所需的版本字段，当前 UI 支持添加和移除，角色更新等待后端补齐版本读模型。
- 当前测试数据集没有连接器时显示“没有外部数据源连接器”，不构造虚假同步状态。

## 自动化结果

- `@kb/web` typecheck、lint：通过。
- `@kb/web` 单元测试：21 个测试文件、82 个测试通过。
- `@kb/service` typecheck：通过。
- `@kb/service` 单元测试：28 个测试文件、134 个测试通过。
- Contract 测试：25 个测试文件、137 个测试通过。
- `@kb/app` typecheck、lint、production build：通过。
- `test/e2e/fastgpt-product-search-info.test.ts`：2/2 通过。
- 四模块联合 E2E：4 个测试文件、8 个测试全部通过。
- Axe serious/critical 为 0；桌面断点无页面级横向溢出。

截图：`test-results/fastgpt-product-module4/search-1440.png`。
