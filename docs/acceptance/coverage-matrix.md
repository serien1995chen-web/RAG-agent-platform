# 能力覆盖口径

本文件只记录架构基座覆盖，不将合同或 mock 宣称为完整业务能力。

| 状态                | 在本基座中的含义                                   |
| ------------------- | -------------------------------------------------- |
| BASE                | 有真实运行时 operation 和真实基础设施证据          |
| DATA                | 有合同、Schema、Port、状态机或 mock；行为 Deferred |
| EXCLUDED            | API、集合、DDL、队列、页面和行为实现均为零         |
| DEFERRED            | 目标合同存在但 runtime 未注册                      |
| EXTERNAL_UNVERIFIED | 合同和 mock 通过，真实外部服务未联调               |

73 项 Capability 的逐项结果由 `knowledge:inventory` 输出与最终验收证据共同
证明：

- 73 个唯一 Capability ID
- 69 个开发项为 BASE 或 DATA
- 4 个 EXCLUDED 项为零实现
- 每个 DATA 项至少关联一个 deferred operation，或明确写明“合同阶段无 operation”
- 每个 BASE 项至少关联一个 runtime operation 或真实基础设施证据

具体 operation 分组见 `docs/contracts/api-contract.md` 和
`docs/contracts/deferred-operations.md`。
