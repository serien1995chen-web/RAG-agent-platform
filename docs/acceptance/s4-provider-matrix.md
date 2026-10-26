# S4 Provider Matrix

Status: `EXTERNAL_UNVERIFIED`

| Provider    | S4 Implementation                | Evidence                           | Real Verification                      |
| ----------- | -------------------------------- | ---------------------------------- | -------------------------------------- |
| File upload | S2 ObjectRef binding             | Import integration/E2E             | Local MinIO only                       |
| Text        | Source ObjectRef snapshot        | E2E and service integration        | Local storage                          |
| URL         | SSRF guard + pinned HTTP request | Fault/integration                  | No public provider credential required |
| Template    | CSV/XLSX pure validation         | Parse unit and service integration | Local fixtures                         |
| Backup      | CSV/XLSX restore plan            | Service integration                | Local fixtures                         |
| Custom API  | Fixed-path JSON contract         | Contract/integration mocks         | `EXTERNAL_UNVERIFIED`                  |
| Feishu      | Provider contract fixture        | Connector E2E/integration          | `EXTERNAL_UNVERIFIED`                  |
| Yuque       | Composite-id provider fixture    | Connector integration              | `EXTERNAL_UNVERIFIED`                  |
| DingTalk    | Wiki/node provider fixture       | Connector integration              | `EXTERNAL_UNVERIFIED`                  |

No mock result is represented as real provider verification.
