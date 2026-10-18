# 知识库工作台（/dataset）

## 边界

- 产品入口：`/dataset/list`；详情：`/dataset/detail/[datasetId]`。
- `/demo/kb` 保留为内部验收控制台，不出现在产品导航；设置页底部保留一个开发者入口。
- 只覆盖知识库模块；不建设 Agent、应用、发布、登录、成员管理，也不建设 Model & AI。

## 信息架构

| 路由                | 内容                                                                         | 主要 API                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `/dataset/list`     | 知识库列表、当前页筛选、类型筛选、创建、重命名、删除                         | `dataset/list`、`dataset/create`、`dataset/update`、`dataset/delete`、`delete-jobs/*`                                                       |
| `?tab=docs`（默认） | 集合/文档：新建文本/文件夹/链接/空集合/文件/图片、导入、标签、移动、删除     | `collection/list`、`collection/create/*`、`collection/update`、`collection/move`、`collection/trainingStatus`、`collection/import`、`tag/*` |
| `?tab=data`         | 按集合浏览数据、服务端搜索、详情、编辑、删除、insertData、pushData、图片追加 | `data/list`、`data/detail`、`data/update`、`data/delete`、`data/insertData`、`data/pushData`、`data/insertImages`                           |
| `?tab=search`       | 三种检索模式、TopK、相似度、Rerank、权重、标签过滤、引用与诊断               | `searchTest`、`tag/list`                                                                                                                    |
| `?tab=training`     | 队列概览、最近任务错误、任务详情、恢复                                       | `training/queue`、`training/errors`、`training/hasError`、`training/collectionErrors`、`training/detail`、`training/resume`                 |
| `?tab=permission`   | 权限快照、继承状态、协作者只读列表、恢复继承                                 | `getPermission`、`resumeInheritPermission`、`proApi/collaborator/list`                                                                      |
| `?tab=settings`     | 名称/自动同步、模型只读、删除知识库、开发者入口                              | `dataset/update`、`dataset/delete`、`delete-jobs/*`                                                                                         |

URL 承载 `tab`、`collectionId`、`page`，切换 Tab/集合/分页后刷新或前进后退保持状态。

## 请求与错误

- 所有请求经 `features/kb/lib/kb-api.ts`；错误以 `code/messageKey/params/requestId` 展示。
- 请求序号防止旧响应覆盖新状态；集合列表与数据列表均使用服务端 `page/limit`。
- 列表搜索只筛当前页并明确标注“当前页筛选”；数据搜索使用 `data/list` 的 `search`。
- `dataset/update`、`collection/update`、`collection/move` 携带 `version`；501067 提示刷新后重试。

## 模型与能力降级

- Dataset 的 `vectorModel/indexVersion` 只读展示。
- `NEXT_PUBLIC_KB_MODEL_MODE=mock` 时，检索与训练页显示 Mock 标识；结果只代表链路验证。
- 模型目录、Provider、API Key 与能力管理不在本模块；需要切换模型或重建到不同模型的入口不提供。
- 图片/文件上传使用公共 `presignUpload → uploadPart → completeMultipart → fileRef` 流程，不调用 `/api/demo/**`。
- `collection/retrain` 后端仍返回 501999（TenantQuotaProvider）；UI 禁用并给出原因。
- API Dataset 未配置 Provider（501017）与链接抓取出网失败（501034）时不做假入口/假成功。
