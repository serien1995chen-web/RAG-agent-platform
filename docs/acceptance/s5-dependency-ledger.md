# S5 Dependency Ledger

## Authorized Changes

| Dependency                   | Version | Declaration                                              | Scope      |
| ---------------------------- | ------- | -------------------------------------------------------- | ---------- |
| `@llamaindex/liteparse-wasm` | `2.0.8` | `packages/parse/package.json` dependency, `catalog:`     | runtime    |
| `@types/turndown`            | `5.0.5` | `packages/parse/package.json` dev dependency, `catalog:` | build/test |

`pnpm-workspace.yaml` catalog now has 109 entries. The dependency ledger already
contained both S5 design entries; the catalog-only exception and expected catalog
count were advanced to the S5 dependency state.

## User Install Record

- Run: first installation only.
- Command: `pnpm install`.
- User-reported exit code: `0`.
- Result summary: 2 packages added; pnpm reported deprecated transitive
  dependencies and peer/ignored-build warnings only.
- Generated lockfile: `pnpm-lock.yaml` changed by pnpm, not by the Coding Agent.
- Agent did not execute `pnpm install/add/update/remove`.
- Second installation: not run; it is a phase 2 gate after S4 merge/rebase.

## Phase 1 Lockfile Facts

- `@llamaindex/liteparse-wasm@2.0.8` resolves from the catalog.
- `@types/turndown@5.0.5` resolves from the catalog.
- Baseline `openai`, `axios`, and `@node-rs/jieba` versions were not changed.
- No AIProxy SDK, OCR SDK, FastGPT SDK, UI SDK, or additional dependency was
  introduced.

The lockfile remains provisional until the user runs the second installation
after S4 rebase.
