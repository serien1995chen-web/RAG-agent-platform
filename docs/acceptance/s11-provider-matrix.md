# S11 Provider Matrix

Result: `SCOPED_BLOCKED`.

Candidate: not frozen. Worktree: `/home/serien/RAG-agent-platform-s11`.
S10 merge: `d7e38c71293a283cd6268605b5036e8ee5763c9a`.

| Provider             | Scoped status       | Real verification     | Evidence                                                                                                          |
| -------------------- | ------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| TokenDance / AIProxy | `SCOPED_BLOCKED`    | `EXTERNAL_UNVERIFIED` | catalog/model profile inputs absent; 14 adapter contract tests pass                                               |
| Somark               | `SCOPED_BLOCKED`    | `EXTERNAL_UNVERIFIED` | profile absent; request/schema/usage contract tests pass                                                          |
| TextIn               | `SCOPED_BLOCKED`    | `EXTERNAL_UNVERIFIED` | profile absent; request/schema/usage contract tests pass                                                          |
| Doc2X                | `SCOPED_BLOCKED`    | `EXTERNAL_UNVERIFIED` | profile absent; preupload/poll/deadline contract tests pass                                                       |
| Feishu               | `SCOPED_BLOCKED`    | `EXTERNAL_UNVERIFIED` | app/folder/doc inputs and controlled delete-propagation case absent; token refresh/pagination contract tests pass |
| Sangfor              | `DEFERRED_BY_SCOPE` | not permitted         | zero scoped real-call guard                                                                                       |
| Yuque                | `DEFERRED_BY_SCOPE` | not permitted         | zero scoped real-call guard                                                                                       |
| DingTalk             | `DEFERRED_BY_SCOPE` | not permitted         | zero scoped real-call guard                                                                                       |

No mock result is counted as a real Provider result.

## Implemented Harness

- `test/real-provider/vitest.config.ts`
- `test/real-provider/s11-aiproxy-real.test.ts`
- `test/real-provider/s11-ocr-real.test.ts`
- `test/real-provider/s11-connectors-real.test.ts`
- `test/real-provider/s11-provider-quota.test.ts`
- `test/fault/s11-provider-fault.test.ts`
- `test/fault/s11-full-chain-recovery.test.ts`

Run:

```bash
S11_SCOPE_PROFILE=knowledge-usability-v1 pnpm test:provider:real
```

Current exit code is `2` with 18 missing scoped field names. No credential value
is printed.
