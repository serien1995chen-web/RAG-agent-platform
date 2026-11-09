# FastGPT 产品化前端模块三验收记录

日期：2026-11-09

分支：`feat/kb-fastgpt-product-ui`

## 范围

- Source 行进入真实 Data / Chunk 页面。
- Data 卡片、Markdown、图片预览、搜索、分页、状态和处理中只读。
- Data 插入、编辑、单项删除、批量删除、批量重建索引。
- 自定义索引新增、编辑、删除，系统索引只读。
- Source 元数据右栏、标签名称与值展示。
- 导入向导四步流程：来源、参数、预览、确认。
- 本地文件、文本、网页、API 文件库、飞书、语雀、钉钉、图片、模板、备份和重训练入口。
- 文件选择、真实上传进度、取消上传、真实导入 Job 和轮询结果。

网站知识库没有出现在导入来源中。

## 数据边界

- 文件上传使用 `/v1/knowledge/uploads*` 的真实会话、分片、完成接口。
- 导入分别调用 `/imports/files`、`/imports/text`、`/imports/url`、`/imports/template`、`/imports/backup`、`/imports/api-library` 和连接器导入接口。
- 导入完成状态只来自 Job 查询，不由前端定时器推断。
- Data 的插入、编辑、删除、批量操作和索引变更均使用真实 API 与版本字段。

## 明确保留的能力缺口

- 当前合同没有导入前分块预览接口。预览步骤展示真实输入摘要，并明确说明分块结果只能由服务端 Job 和 Data 列表返回。
- 当前合同没有分块 CSV 导出接口。“导出分块”入口保留并显示真实能力缺口，不使用原文件下载冒充。
- 当前合同没有 Source 重训练提交接口。重训练入口保留并显示能力缺口。
- 新增图片 Segment 没有独立合同；图片新增指向 Import 的图片集合来源。

## 自动化结果

- `@kb/web` typecheck、lint：通过。
- `@kb/web` 单元测试：21 个测试文件、82 个测试通过。
- `@kb/service` typecheck：通过。
- `@kb/service` 单元测试：28 个测试文件、134 个测试通过。
- `@kb/app` typecheck、lint、production build：通过。
- Contract 测试：25 个测试文件、137 个测试通过。
- `test/e2e/fastgpt-product-data-import.test.ts`：2/2 通过。
- 模块一至模块三联合 E2E：6/6 通过。
- E2E 覆盖真实 Data 编辑、插入、批量删除、标签元数据、文本导入、本地文件上传和 Job 状态。
- Axe serious/critical 为 0；1440px、1200px、900px 无页面级横向溢出。

截图：

- `test-results/fastgpt-product-module3/data-1440.png`
- `test-results/fastgpt-product-module3/import-result-1200.png`
