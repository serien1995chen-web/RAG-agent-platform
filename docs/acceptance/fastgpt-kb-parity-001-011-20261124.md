# FastGPT Knowledge Base Parity Closure: 001-011

## Baseline

- Project branch: `codex/kb-fastgpt-parity-001-011-20261124`
- Project base: `bb1168aea621039c51e7dd2e0be1d40e8e04ff49`
- FastGPT source: `D:\Fastgpt\FastGPT`
- FastGPT version: `4.0`
- FastGPT root `package.json` SHA-256:
  `EA51D3C46F0F280B7CE1C672DD006A667E935E412199480BC6FA1686C426ECF1`
- Scope: `KB-PARITY-001` through `KB-PARITY-011`

## Closure Matrix

| Item          | Result | Implemented behavior                                                                                                                                                                         |
| ------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KB-PARITY-001 | PASS   | Creation still exposes only index, text understanding, and optional image understanding models.                                                                                              |
| KB-PARITY-002 | PASS   | Info exposes exactly three model selectors. Rerank is configured only in Search Configuration; STT/TTS remain compatible backend fields but are absent from the knowledge foreground.        |
| KB-PARITY-003 | PASS   | Info uses a collaborator summary. ACL state, permission revisions, principal types, and free-form member IDs are absent from ordinary UI.                                                    |
| KB-PARITY-004 | PASS   | A reusable 40/60 collaborator manager supports member/department/group selection, role changes, unified confirmation, cancellation without writes, owner protection, and ownership transfer. |
| KB-PARITY-005 | PASS   | Jobs navigation is removed from knowledge pages. The old Jobs URL redirects to the dataset and source status remains available in the file row.                                              |
| KB-PARITY-006 | PASS   | Operations is removed from desktop/mobile knowledge navigation. The old URL redirects to the knowledge list; operational APIs remain intact.                                                 |
| KB-PARITY-007 | PASS   | Search Test uses the input, Search Configuration, full-width Test button, history, results layout, and approximately 468px left pane.                                                        |
| KB-PARITY-008 | PASS   | Search Configuration uses Search Method, Search Filter, and Query Optimization tabs with FastGPT-aligned conditional fields.                                                                 |
| KB-PARITY-009 | PASS   | Defaults are semantic search, similarity 0, quote budget 5000, rerank off, and query optimization off. Knowledge Search Test exposes only three modes and no Deep RAG.                       |
| KB-PARITY-010 | PASS   | ReRank candidate count is optional in the API, defaults to 100, accepts 10-100, is carried into the pipeline, and limits the candidate slice sent to reranking.                              |
| KB-PARITY-011 | PASS   | Each result stores its execution settings. Selecting history renders that entry's saved parameters rather than current settings.                                                             |

## Interface Changes

- Added optional `rerankCandidateNum` to search API and pipeline contracts.
- Added internal `GET /api/console/directory`; it is not a canonical OpenAPI operation.
- Added `KB_CONSOLE_DIRECTORY_FILE` for member, department, group, display-name, and avatar metadata.
- Member grants use collaborator endpoints; department/group grants map to ACL `org`/`group` principals.
- No database migration is required.

## Verification

Passing checks:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`
- `pnpm openapi:check`: 96 paths, 124 operations, 142 schemas
- `pnpm test:unit`: all package unit tasks passed, including contracts, search, web, service, parse, chunk, storage, and app units
- `fastgpt-parity-001-011.test.ts`: 3/3 passed
- Updated affected E2E suites passed, including product list/detail/search, permissions, lifecycle, Jobs, Operations, Deep RAG absence, image search, and accessibility checks

Full E2E with local Mongo, Redis, PostgreSQL, and MinIO:

- 250 tests discovered: 216 passed, 33 skipped by existing environment gates, 1 transient Axe failure while a modal close animation was still active.
- The modal check now waits for animation completion; the affected parity file was rerun and passed 3/3.

Contract suite:

- 193 tests discovered: 191 passed, 2 existing `B18-B` FastGPT source-snapshot checks failed because its fixture pins older file hashes and line bounds than the supplied FastGPT source tree.

## Evidence

- `test-results/fastgpt-parity-001-011/collaborators-1200.png`
- `test-results/fastgpt-parity-001-011/search-1200.png`
- `test-results/fastgpt-parity-001-011/search-1440.png`
- `test-results/fastgpt-parity-001-011/console-directory.json`

## Scope Boundary

Items `KB-PARITY-012` through `KB-PARITY-021` remain out of scope for this change. The original Desktop audit report and evidence directory remain unchanged.
