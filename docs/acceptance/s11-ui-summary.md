# S11 UI Matrix Summary

Result: `SCOPED_BLOCKED`.

Candidate: not frozen.

The production build was started at `http://127.0.0.1:3010`, `/healthz` and
`/readyz` returned `200`, and the real Playwright matrix ran:

```text
pnpm exec playwright test --config test/e2e/playwright.s11.config.ts
1 passed
```

| Item                             | Result                                                             |
| -------------------------------- | ------------------------------------------------------------------ |
| Canonical pages                  | 18                                                                 |
| Viewports                        | 360x800, 768x900, 1200x900                                         |
| Screenshots                      | 54                                                                 |
| Screenshot hashes                | 54                                                                 |
| serious/critical axe findings    | 0                                                                  |
| overflow findings                | 0                                                                  |
| browser/runtime request failures | 0                                                                  |
| `ui-summary.json` SHA-256        | `4686ca2bc645b609a66e1a03e55e5d1c443c5e0878f82f1370838005360ad31d` |

Evidence is stored outside the worktree under `S11_UI_EVIDENCE_DIR`.

The overall S11 result remains blocked because real Provider, full k6
performance and production image evidence are incomplete. Recovery has a
separate real generate/consume PASS.
