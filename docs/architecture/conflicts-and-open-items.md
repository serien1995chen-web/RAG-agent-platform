# 冲突与未验证项

## 已裁决

| ID    | 冲突                               | 裁决                                            |
| ----- | ---------------------------------- | ----------------------------------------------- |
| C-001 | 历史路由数量 84/86/87 并存         | 目标合同固定 92 paths / 120 operations          |
| C-002 | 历史数字错误码与骨架占位码         | 全部退出 canonical；只使用 `KNOWLEDGE_*`        |
| C-003 | 历史 `teamId` 与新版 `workspaceId` | `workspaceId` 是唯一租户键                      |
| C-004 | 旧规范禁止 Outbox/Saga             | 新版要求 Mongo 事务内 Outbox 与 Saga step       |
| C-005 | 历史 Dataset 聚合                  | 硬切为 Knowledge Space/Directory/Source/Segment |
| C-006 | 1536-only pgvector                 | 768/1024/1536 `vector`，3072 `halfvec`          |
| C-007 | 旧十个 Dataset 队列                | 硬切为 13 个 `knowledge-*` 队列                 |

## EXTERNAL_UNVERIFIED

| Provider | 已有证据                                       | 缺失证据           |
| -------- | ---------------------------------------------- | ------------------ |
| AIProxy  | HTTP 合同、mock、timeout、错误分类             | 真实凭证与联调     |
| OCR      | 判别联合合同、mock、fallback                   | 真实 Provider 凭证 |
| 飞书     | credential redaction、catalog/cursor/sync mock | 真实 tenant 授权   |
| 语雀     | credential redaction、catalog/cursor/sync mock | 真实 token         |
| 钉钉     | credential redaction、catalog/cursor/sync mock | 真实应用凭证       |

上述项目不得写成 PASS 或“已联调”。
