# FastGPT 产品化前端四模块整体验收

日期：2026-11-09

分支：`feat/kb-fastgpt-product-ui`

## 完成范围

- `/dataset/list`：知识库、文件夹、搜索筛选排序、创建、编辑、移动、导出、删除、批量、权限和拖放。
- `/dataset/detail`：Collection、目录、Source、标签、训练状态、权限、Data、Import、Search Test 和 Info 右栏。
- Data / Chunk：浏览、Markdown、搜索、编辑、插入、删除、批量操作、索引和元数据。
- Import：文件、文本、网页、API 文件库、飞书、语雀、钉钉、图片、模板、备份和重训练入口。
- Search Test：文本、图片、参数、引用、耗时、空结果和 50 条隔离历史。
- Info：基本资料、模型绑定、Source 权限、协作者和连接器同步。

网站知识库已从创建、筛选、导入、路由和测试中排除。

## 真实数据与状态

- 所有业务数据通过 `/v1/knowledge/*`。
- 写操作使用真实版本字段、幂等键和服务端错误。
- 上传进度来自真实 upload 事件，导入完成状态来自 Job。
- 轮询页面隐藏时暂停，不生成前端完成状态。
- 无 Mock 业务数据、硬编码成功、前端模拟上传或伪造任务进度。

## 最终门禁

- OpenAPI：92 paths、120 operations、139 schemas。
- Runtime：120；Deferred：0；旧 page route：0。
- `@kb/web`：21 个单元测试文件、82 个测试通过。
- `@kb/service`：28 个单元测试文件、134 个测试通过。
- Contract：25 个测试文件、137 个测试通过。
- 四模块 E2E：4 个文件、8 个测试全部通过。
- `@kb/app` production build：通过。
- Prettier、ESLint、TypeScript：通过。
- Axe serious/critical：0；1440px、1200px、900px 无页面级横向溢出。

## 后端能力缺口

- 服务端列表检索、创建者显示名和知识库类型字段仍缺失；前端只用真实分页数据做展示层筛选，并展示真实成员 ID。
- 当前合同无导入前分块预览和分块 CSV 导出接口。
- 当前合同无 Source 重训练提交接口。
- Segment 合同无新增图片接口；图片新增走 Import 图片集合。
- Search 合同无查询扩展 Prompt 和具体 ReRank 模型选择字段。
- Collaborator DTO 无更新版本字段，当前只支持添加和移除，不伪造角色更新。
- Source 列表 DTO 仍未返回 `segmentCount` 和更新时间，页面显示“后端未提供”。
