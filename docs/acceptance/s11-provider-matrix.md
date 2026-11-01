# S11 Provider Matrix

Result: `SCOPED_BLOCKED`.

Candidate: `UNFROZEN`.

Fixture SHA-256: `82b20e68f2eb52d5f0dc2c3b604be348adf1f3cff448fec281a9bb4e9f971cee`.

Input manifest SHA-256: `UNAVAILABLE`.

| Provider             | Status                | Command / evidence                                                                                                                                 | Remaining risk                  |
| -------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| TokenDance / AIProxy | `EXTERNAL_UNVERIFIED` | S11_SCOPE_PROFILE=knowledge-usability-v1 pnpm test:provider:real -- s11-aiproxy-real; t02-aiproxy.json sha256=missing; host=none                   | S11_EVIDENCE_DIR missing        |
| Somark               | `EXTERNAL_UNVERIFIED` | S11_SCOPE_PROFILE=knowledge-usability-v1 pnpm test:provider:real -- s11-ocr-real; t02-ocr.json sha256=missing; host=none                           | S11_EVIDENCE_DIR missing        |
| TextIn               | `EXTERNAL_UNVERIFIED` | S11_SCOPE_PROFILE=knowledge-usability-v1 pnpm test:provider:real -- s11-ocr-real; t02-ocr.json sha256=missing; host=none                           | S11_EVIDENCE_DIR missing        |
| Doc2X                | `EXTERNAL_UNVERIFIED` | S11_SCOPE_PROFILE=knowledge-usability-v1 pnpm test:provider:real -- s11-ocr-real; t02-ocr.json sha256=missing; host=none                           | S11_EVIDENCE_DIR missing        |
| 飞书                 | `EXTERNAL_UNVERIFIED` | S11_SCOPE_PROFILE=knowledge-usability-v1 pnpm test:provider:real -- s11-connectors-real; t02-connectors.json sha256=missing; host=3b1b05eb4480d8b8 | S11_EVIDENCE_DIR missing        |
| Sangfor              | `DEFERRED_BY_SCOPE`   | pnpm test:contract -- s11-provider-adapters; zero-real-call guard=MISSING                                                                          | deferred guard evidence missing |
| 语雀                 | `DEFERRED_BY_SCOPE`   | pnpm test:contract -- s11-provider-adapters; zero-real-call guard=MISSING                                                                          | deferred guard evidence missing |
| 钉钉                 | `DEFERRED_BY_SCOPE`   | pnpm test:contract -- s11-provider-adapters; zero-real-call guard=MISSING                                                                          | deferred guard evidence missing |

No mock transport or unverified Provider is counted as real.
