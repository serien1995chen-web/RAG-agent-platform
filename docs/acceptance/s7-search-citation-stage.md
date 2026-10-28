# S7 Search and Citation Stage Evidence

## Status

- Wave / stage / owner: W2 / S7 / personA.
- Parallel stage: S6 / personB.
- Branch: `feat/kb-s07-search-citation`.
- W2 baseline: `87ba3bdea3d7daf3e738a04998b80b49cbf7a77b`.
- S6 merge SHA: `bc091a1513ec0a0b0b2b9412f0c8a397192ea3de`.
- S6 candidate: `c398593db550e6d4832a24642b368f11bac22ff8`.
- S6 evidence HEAD: `e6ca0d309f59cc69d018d8f79c8029fc809913a2`.
- Candidate SHA: `d237c028b514a923920cbc36bcb1bb71ee4d9747`.
- Evidence commit SHA: `PENDING_DOCS_ONLY_EVIDENCE`.
- Phase 1: `PASS` for deterministic S7 component, handler and fixture tests.
- Phase 2: implementation, component integration and clean candidate gate PASS.
- PersonB: `PASS` on the same candidate without dependency installation.
- PersonA: `PASS`.
- Wave W2: `BOTH_LOCAL_GATES_PASS_PENDING_CI_AND_REVIEW`.

The S6 candidate and S6 evidence HEAD are both ancestors of the current branch.
This document does not claim W2 completion before personA and personB pass on
the same frozen candidate and CI binds the final evidence commit.

## Scope

Tasks:

```text
S7-T01 S7-T02 S7-T03 S7-T04 S7-T05
S7-T06 S7-T07 S7-T08 S7-T09 S7-T10
```

Runtime operations added in phase 2:

```text
API-SEARCH-SEMANTIC
API-SEARCH-FULLTEXT
API-SEARCH-HYBRID
API-SEARCH-MULTI
API-CITATION-GET
```

Capability disposition:

- Implemented/closed ledger: `47 / 43` DATA capabilities.
- Closed in S7: `SEARCH-001`, `SEARCH-002`, `SEARCH-004`, `SEARCH-005`,
  `SEARCH-007`, `SEARCH-009`.
- S7 subsets implemented but not closed: `DOWN-001`, `DOWN-002`,
  `DOWN-003`; all three remain `DATA` until the S10 real API Key lifecycle.
- The canonical capability manifest remains `DATA`; closure is stage evidence,
  not a source-manifest rewrite.

S7 implements nine task areas: vector recall and final ACL, full-text and RRF,
safe filters and tag operators, rerank/weights/token budget, dedupe/similarity/
trim/partial, multi-space merge, citation lifecycle, downstream HTTP contracts,
and the Search UI. It closes six SEARCH capabilities.

## Phase Separation

Phase 1 commits:

```text
86470c3 chore(s7): declare phase1 dependencies
a5e1d2f feat(s7): implement phase1 search and citation core
0fd51d3 fix(s7): clear stale results and align citation text
```

Phase 1 used the frozen OpenAPI/schema, deterministic fixtures and the existing
`@kb/search` engine. It kept runtime `83 / 37`, registered no S7 operation, and
exposed no public Search page or navigation.

Phase 2:

- Rebased on the user-confirmed S6 merge without reset, force push or cherry-pick.
- Retained all S6 queues, handlers, schemas, UI, tests, dependencies and generated
  artifacts.
- Retained the deterministic S7 fixture suite and replaced the phase2 integration
  path with real S6 Job/Index output.
- Registered only the five S7 operations in the existing runtime allowlist.
- Appended Search navigation and the Search page to the S6-integrated UI.
- Generated the S6+S7 OpenAPI union only with `pnpm openapi:generate`.

## Contract And Runtime

Final phase2 inventory:

| Check                           | Result    |
| ------------------------------- | --------- |
| Paths                           | `92`      |
| Operations                      | `120`     |
| Schemas                         | `139`     |
| Parameters                      | `8`       |
| Runtime                         | `100`     |
| Deferred                        | `20`      |
| Runtime / deferred intersection | `0`       |
| Runtime / deferred union        | `120`     |
| S6 runtime operations           | `12 / 12` |
| S7 runtime operations           | `5 / 5`   |
| Mongo collections               | `23`      |
| Vector profiles                 | `4`       |
| Canonical queues                | `13`      |

`pnpm knowledge:inventory`, `pnpm knowledge:check-runtime` and
`pnpm openapi:check` pass. S8 Image/Deep and later operations remain deferred.

## C3: Real S6 To S7

`packages/service/test/integration/s7-s6-integration.test.ts` drives the real S6
index Job for two distinct Spaces and reads the resulting data through S7:

- S6 writes `knowledge_segments.indexes[]`, full-text projection, full-text
  version and pgvector 768 rows through the existing index worker path.
- S7 full-text and vector recall return the Segment IDs, Source IDs and index
  versions written by S6.
- S7 hydrates current Mongo Space/Source/Segment state and applies the final ACL.
- `API-SEARCH-MULTI` runs against both real indexed Spaces, returns two distinct
  Space candidates, and issues distinct citations with provenance.
- Revoked, disabled, deleted or stale-index candidates are discarded after
  recall.

S7 does not write vectors or full text, create index Jobs, rebuild Segments or
copy an S6 writer.

## C6: Search Security Scope

C6 S7 verification covers:

- `knowledge:search` scope behavior.
- Workspace tenant isolation and cross-workspace 404/403 behavior.
- Source/Space permission and permission-revision reauthorization.
- Safe degraded/partial responses and failed-search audit summaries.
- Citation reauthorization before returning the snapshot.

No API Key create/rotate/revoke, usage administration, admin operation or final
S10 lifecycle was implemented.

## Search Behavior

- Semantic, full-text, hybrid and multi-space operations are reachable through
  the existing runtime.
- Filters cover source, directory, creation time and all approved tag operators.
- Tag logic supports `AND` and `OR`; regex input uses the declared safe-regex
  path and never becomes an unbounded Mongo regex.
- Hybrid scoring uses weighted RRF, then deterministic score-domain reranking.
- Dedupe, similarity cut, stable ordering and token-budget trimming happen before
  citation issuance.
- Partial and degraded states distinguish HTTP `200`, `207`, `4xx` and `5xx`
  contracts.
- Rerank remains a deterministic mock and is not labelled `REAL_VERIFIED`.

## Citation Lifecycle

- Citation IDs use workspace-scoped HMAC signatures and a 24-hour TTL.
- Persisted records carry search provenance, snapshot hash, source URL, range,
  score and Segment version.
- Citation GET performs a second ACL check and returns `404` for deleted,
  revoked, disabled or expired records.
- Search issuance writes the search audit transactionally; citation GET does not
  create a new audit event.

## Downstream HTTP Contract

`S7DownstreamKnowledgeClient` calls only `/v1/knowledge/*`, contains no internal
database import, and distinguishes:

- successful `200`;
- partial `207`;
- empty successful result;
- degraded result;
- citation lookup success and unavailable/not found.

Chat, Agent and Workflow consumer fixtures cover the S7 subset of
`TEST-DOWN-001...003-BLOCK`. Their capabilities remain `DATA` because real API
Key closure belongs to S10.

## Search UI

The Search page and bottom navigation were added only after the S6 rebase:

- semantic/fulltext/hybrid/multi-space controls;
- token budget, similarity and rerank controls;
- safe filter editor and tag operators;
- partial, degraded, empty, permission, timeout, rate-limit and retry states;
- Markdown, GFM, KaTeX, Mermaid sanitization and citation metadata.

The real app E2E drives an S6 index Job through the downstream HTTP client and
then renders the Search page at `360`, `768` and `1200`. Blocking axe defects,
horizontal overflow, unexpected console errors and failed runtime requests are
zero.

| Screenshot           | SHA-256                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `s7-search-360.png`  | `76e87f76669cd25cec34a24fdd09abf682d2c4d9fa8fc2c2e9ec0b70ca476aa9` |
| `s7-search-768.png`  | `9221a0fbdd2c522426a4749691efd5347cbfe6e74f1309e0a132cb3e1c445f43` |
| `s7-search-1200.png` | `56fa3f71a6ff6e08c5aef5c8e03bba292c49aab5eb76de0c462938ffbb1c506a` |

## Dependencies And Generated Files

- Catalog entries: `159`.
- S7 dependency declaration: exactly 21 catalog entries, all already recorded in
  the frozen dependency ledger.
- User install 1: exit `0`; lockfile SHA-256
  `9e376a6d474a27c7a0abd4d4fcee7b3c6dafcea45663499655cb1570cebea844`.
- User install 2 after the S6 rebase: exit `0`; final lockfile SHA-256
  `31756b79284db42258c9140ca3c9c7ccb195d819633b05b6eaa3de7d0e59e72f`.
- The second install lockfile is committed as `7848cda`.
- Coding did not run `pnpm install`, add, update or remove.
- OpenAPI registries, target contract and client type artifacts were produced by
  `pnpm openapi:generate`; they were not hand-edited.

## Test Coverage

Candidate gates at `d237c028b514a923920cbc36bcb1bb71ee4d9747`:

- Targeted S7 page/HTTP E2E: `2 / 2`.
- Real C3 S6-to-S7 integration: `1 / 1`.
- S6 deterministic fixture S7 data integration: `3 / 3`.
- Unit: Turbo `22 / 22` tasks.
- Contract: `90 / 90`.
- Integration: Turbo `22 / 22`; service `129 / 129`.
- Tenant: `15 / 15`.
- Concurrency: `13 / 13`.
- Fault: `32 / 32`.
- E2E: `41 / 41` tests in nine files.

The complete clean-candidate command matrix, exit codes, output hashes, test IDs
and environment are recorded in `docs/acceptance/w2-personA-gate.md` after the
candidate is frozen.

## Real / Mock / External

Real verified:

- Mongo replica set, Redis, PostgreSQL with pgvector and MinIO.
- S6 Job/Index writes and S7 reads of real full-text/vector projections.
- Mongo ACL reauthorization and citation records.
- The built Next app, downstream HTTP client and three-viewport browser E2E.

Mock pass:

- Deterministic embedding gateway used for the local mock model and real S6
  index path.
- Deterministic rerank behavior.
- Downstream Chat/Agent/Workflow consumers.

External unverified:

- Real external embedding and rerank providers.
- S10 real API Key lifecycle.
- Production IAM and provider-side quota/billing.

## Remaining Work

- PersonB returned `PASS` at the same candidate; its content is preserved
  byte-for-byte in `docs/acceptance/w2-personB-gate.md`.
- Create the docs-only evidence commit, push it through the user/reviewer flow,
  and run CI at that commit.
- Run CI at `evidenceCommitSha` and bind the URL through Review/PR Review.

## Boundary

- No S6 writer, queue, handler or test was removed.
- No Image/Deep, Synonym, API Key, ops page or old Dataset path was added.
- `DOWN-001...003` remain `DATA`; no deferred fake success was introduced.
- S11 was not implemented or modified.
