# 知识库工作台能力矩阵

探测环境：demo compose（Mongo/Redis/pgvector/MinIO），`model=mock`。
原始探测：`outputs/kb-product-ui-20261018/capability-raw.json`。

状态：`usable` / `partial` / `blocked` / `out-of-scope`。blocked 动作在 UI 中禁用或隐藏，并显示原因。

## Dataset

| 动作              | Route ID     | Method/Path                               | 实测                        | 状态    | UI 处理                                                                                           |
| ----------------- | ------------ | ----------------------------------------- | --------------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| 列表              | API-DS-001   | GET `/api/core/dataset/list`              | 200                         | usable  | 服务端分页；当前页名称筛选                                                                        |
| 创建知识库/文件夹 | API-DS-002   | POST `/api/core/dataset/create`           | 200                         | usable  | 新建抽屉；模型只读 bge-m3                                                                         |
| 详情              | API-DS-003   | GET `/api/core/dataset/detail`            | 200                         | partial | 后端 `stats.collections/datas` 恒为 0；UI 用 `collection/list.total` 显示集合数，不展示虚假数据数 |
| 重命名/自动同步   | API-DS-004   | POST `/api/core/dataset/update`           | 200                         | usable  | 带 version；501067 提示刷新                                                                       |
| 删除              | API-DS-005   | POST `/api/core/dataset/delete`           | 200                         | partial | 删除 job 抽屉可读；本环境删除消费者未推进，状态停在 queued，记为后端缺口                          |
| 移动              | API-PATH-003 | POST `/api/core/dataset/move`             | 409（探测用了过期 version） | partial | 仅在有文件夹时提供；带最新 version                                                                |
| 路径              | API-PATH-001 | GET `/api/core/dataset/paths`             | 200                         | usable  | 只在需要时读取                                                                                    |
| 导出              | API-EXP-001  | GET `/api/core/dataset/exportAll`         | 200（二进制）               | usable  | fetch blob 下载                                                                                   |
| 重建向量          | API-DS-006   | POST `/api/core/dataset/rebuildEmbedding` | 500 / 501013（同模型被拒）  | blocked | 禁用，提示需 Model & AI 提供其他模型                                                              |

## Collection

| 动作        | Route ID                   | Method/Path                               | 实测                             | 状态    | UI 处理                                                         |
| ----------- | -------------------------- | ----------------------------------------- | -------------------------------- | ------- | --------------------------------------------------------------- |
| 列表        | API-COL-001                | GET `/api/core/dataset/collection/list`   | 200                              | partial | 服务端 page/limit；type 参数未生效，类型筛选为当前页客户端过滤  |
| 详情        | API-COL-011                | GET `/api/core/dataset/collection/detail` | 200                              | partial | 该接口 trainingStatus 固定 ready；UI 改用 `trainingStatus` 端点 |
| 文本        | API-COL-005                | POST `/collection/create/text`            | 200                              | usable  | 新建集合 → 文本；轮询训练                                       |
| 文件夹      | API-COL-002                | POST `/collection/create/folder`          | 200                              | usable  | 新建集合 → 文件夹                                               |
| 链接        | API-COL-004                | POST `/collection/create/link`            | 504 / 501034（本环境出网超时）   | partial | 入口保留，失败展示 501034 与原因；不伪造链接数据                |
| 空集合      | API-COL-017                | POST `/collection/create/empty`           | 200                              | usable  | 新建集合 → 空集合                                               |
| 文件        | API-COL-003                | POST `/collection/create/file`            | 200                              | usable  | 公共上传后创建                                                  |
| 图片        | API-COL-008                | POST `/collection/create/images`          | 200，items 非空                  | usable  | 公共上传 fileRef + auto/chunk/image/imageParse                  |
| API Dataset | API-COL-007                | POST `/collection/create/apiFile`         | 400 / 501017                     | blocked | 不出现入口；写明 Provider 未配置                                |
| 重命名/移动 | API-COL-012 / API-PATH-004 | POST `/collection/update` / `move`        | 200                              | usable  | 标签抽屉与移动对话框；带 version                                |
| 同步        | API-COL-015                | POST `/collection/sync`                   | 502 / 501019（文本集合）         | partial | 仅链接/API 文件类型显示同步；失败可见                           |
| 重训        | API-COL-014                | POST `/collection/retrain`                | 501 / 501999                     | blocked | 按钮禁用，title 说明 TenantQuotaProvider 未接入                 |
| 训练状态    | API-COL-016                | GET `/collection/trainingStatus`          | 200 running→ready                | usable  | 2.5–3s 轮询，终态停止                                           |
| 导出        | API-EXP-002                | GET `/collection/export`                  | 200（JSONL）                     | usable  | blob 下载                                                       |
| 导入        | API-IMP-001                | POST `/collection/import`                 | 200，报告 success/skipped/failed | usable  | 导入抽屉；JSONL/CSV 文件                                        |
| 删除        | API-COL-010                | POST `/collection/delete`                 | 200                              | partial | 删除 job 抽屉；与 Dataset 删除相同的消费者缺口                  |

## Data

| 动作     | Route ID     | Method/Path               | 实测 | 状态   | UI 处理                     |
| -------- | ------------ | ------------------------- | ---- | ------ | --------------------------- |
| 列表     | API-DATA-001 | GET `/data/list`          | 200  | usable | page/limit + 服务端 search  |
| 详情     | API-DATA-002 | GET `/data/detail`        | 200  | usable | 详情抽屉；原始元数据折叠    |
| 编辑     | API-DATA-003 | POST `/data/update`       | 200  | usable | 带 version；501067 提示刷新 |
| 删除     | API-DATA-004 | POST `/data/delete`       | 200  | usable | 确认后刷新                  |
| 直接插入 | API-DATA-005 | POST `/data/insertData`   | 200  | usable | q 必填                      |
| 批量推送 | API-DATA-007 | POST `/data/pushData`     | 200  | usable | ≤200 条 / 10MB 前端校验     |
| 图片追加 | API-DATA-006 | POST `/data/insertImages` | 200  | usable | 仅 images 集合显示          |

## Search / Training / ACL

| 动作           | Route ID             | Method/Path                                  | 实测                        | 状态    | UI 处理                                        |
| -------------- | -------------------- | -------------------------------------------- | --------------------------- | ------- | ---------------------------------------------- |
| embedding      | API-SEARCH-001       | POST `/searchTest`                           | 200，有 citations           | usable  | 默认模式                                       |
| fullTextRecall | API-SEARCH-001       | POST `/searchTest`                           | 200                         | usable  | 下拉选项                                       |
| mixedRecall    | API-SEARCH-001       | POST `/searchTest`                           | 200                         | usable  | 下拉选项                                       |
| 标签过滤       | API-SEARCH-001       | `collectionFilterMatch`                      | 200                         | usable  | 只生成 `{tags:{$and:[...]}}`，不伪造集合表达式 |
| 队列/错误      | API-TASK-006/008/009 | GET/POST `/training/*`                       | 200                         | usable  | 队列表、hasError、集合错误                     |
| 错误列表       | API-TASK-002/007     | GET/POST `/training/errors`                  | 404/501070（无错误时）      | partial | 404 显示“没有错误记录”                         |
| 任务详情       | API-TASK-001         | GET `/training/detail`                       | 200（有 taskId 时）         | partial | 从错误列表进入                                 |
| 恢复           | API-TASK-003         | POST `/training/resume`                      | 仅 failed 任务可用          | partial | 仅失败任务显示，填写原因                       |
| 权限快照       | API-ACL-001          | GET `/getPermission`                         | 200                         | usable  | 快照字段展示                                   |
| 恢复继承       | API-ACL-002          | POST `/resumeInheritPermission`              | 409（探测用了过期 version） | partial | 带最新 version；501067 提示刷新                |
| 协作者         | API-ACL-004          | GET `/proApi/core/dataset/collaborator/list` | 200                         | usable  | 只读列表；当前固定开发身份                     |
| 变更 Owner     | API-ACL-005          | POST `/proApi/.../transferOwner`             | 需要第二身份                | blocked | 不显示假按钮                                   |

## Files / Delete jobs

| 动作                        | Route ID             | Method/Path                         | 实测                   | 状态    | UI 处理                                           |
| --------------------------- | -------------------- | ----------------------------------- | ---------------------- | ------- | ------------------------------------------------- |
| presign / upload / complete | API-FILE-001/002/007 | `/file/*`                           | 200，fileRef 可用      | usable  | 产品级上传 helper（SHA-256 + multipart ETag MD5） |
| 删除任务详情                | API-DEL-001          | GET `/delete-jobs/{jobId}`          | 200                    | usable  | 任务抽屉轮询                                      |
| 失败项                      | API-DEL-002          | GET `/delete-jobs/{jobId}/failures` | 200                    | usable  | 失败列表                                          |
| 重试                        | API-DEL-003          | POST `/delete-jobs/{jobId}/retry`   | 409/501040（无失败项） | partial | 仅在 failures>0 时显示                            |

## 已知后端缺口

1. `dataset/detail.stats` 的 collections/datas 不反映真实集合/数据，UI 不展示 datas，并用 collection list total 代替 collections。
2. 删除任务在本 demo 环境持续 `queued`（job/failures 可读，消费者未推进）——记录为 BACKEND-GAP，不修改后端。
3. `collection/retrain` 仍为 501999；`TenantQuotaProvider` 与 sourceRef 持久化未闭环。
4. `dataset/rebuildEmbedding` 要求不同模型；模型目录属于 Model & AI，本模块不提供。
5. `collection/list.type` 参数未传 service；`collection/detail.trainingStatus` 固定 ready。
