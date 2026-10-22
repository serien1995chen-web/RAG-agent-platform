# 架构扩展边界

当前基座不保留旧扩展注册表或旧扩展 catch-all 路由。所有能力必须通过已冻结的
`/v1/knowledge/*` operation、application Port 或 Deferred manifest 扩展。

## 允许的扩展方向

| 方向       | 当前基座                                                    | 后续状态 |
| ---------- | ----------------------------------------------------------- | -------- |
| Provider   | AIProxy、OCR、飞书、语雀、钉钉判别联合合同、timeout 和 mock | F5       |
| Repository | workspace-scoped repository 与真实基础设施 Port             | 已实施   |
| Jobs       | Mongo CAS/租约/fencing + Outbox + BullMQ 投递               | F2       |
| Search     | 搜索算法包与合同；runtime search operation 仍 Deferred      | F3       |
| Connectors | connector 集合与 mock 合同；同步和目录浏览仍 Deferred       | F1/F5    |
| Console UI | 九个基座页面与 App Shell                                    | 已实施   |

## 约束

- 新 operation 必须先进入目标合同并获得用户批准，不能通过 catch-all 动态放行。
- Deferred operation 不得注册运行时路由，也不得在 UI 显示为可用。
- 外部 Provider 未取得真实凭证和联调证据时保持 `EXTERNAL_UNVERIFIED`。
- 禁止复制来源项目的源码、Prompt、Schema、目录、部署文件、页面或品牌素材。
- 禁止引入旧数字业务码、假成功、空对象占位或未批准 alias。
