# W2 Wave Evidence

## Decision

- Wave: `W2`.
- Stages: S6 job/index with parallel S7 search/citation.
- Branch: `feat/kb-s07-search-citation`.
- Candidate SHA: `d237c028b514a923920cbc36bcb1bb71ee4d9747`.
- Evidence commit SHA: `PENDING_DOCS_ONLY_EVIDENCE_COMMIT`.
- PersonA: `PASS`.
- PersonB: `PASS`.
- Wave result: `BOTH_LOCAL_GATES_PASS_PENDING_CI_AND_REVIEW`.

W2 is locally proven at one candidate. CI at the final docs-only evidence commit,
Review and PR Review remain required before declaring `W2_PASS`.

Evidence hashes:

- PersonA:
  `de40bad5245796dc6a9cd062e31dcd8129ef6d7f3f4b2b727b529d81754149d9`.
- PersonB:
  `e770f48a8879b2faedce378415ba4dd930343660347c7bd29305eb7d0d490a9c`.
- S7 stage evidence:
  `e67992942ad04f0ef2129b0fc21d9a3da5c0156273a6c09c2f3aade01a032e21`.

PersonB content is preserved byte-for-byte in
`docs/acceptance/w2-personB-gate.md`; it was not rewritten by personA.

## Candidate

| Check                      | Result                                                             |
| -------------------------- | ------------------------------------------------------------------ |
| W2 baseline                | `87ba3bdea3d7daf3e738a04998b80b49cbf7a77b`                         |
| S6 merge                   | `bc091a1513ec0a0b0b2b9412f0c8a397192ea3de`                         |
| S6 candidate               | `c398593db550e6d4832a24642b368f11bac22ff8`                         |
| S6 evidence HEAD           | `e6ca0d309f59cc69d018d8f79c8029fc809913a2`                         |
| Candidate                  | `d237c028b514a923920cbc36bcb1bb71ee4d9747`                         |
| Candidate subject          | `feat(s7): integrate search and citation with s6`                  |
| Remote candidate branch    | PASS: `d237c028...` matches `origin/feat/kb-s07-search-citation`   |
| Remote main                | PASS: `bc091a15...`                                                |
| W2 base / S6 ancestry      | PASS; both are candidate ancestors                                 |
| Candidate worktree         | PASS: tracked worktree empty before and after both gates           |
| Candidate lockfile SHA-256 | `31756b79284db42258c9140ca3c9c7ccb195d819633b05b6eaa3de7d0e59e72f` |
| Test ID preservation       | PASS: `130 -> 140`; no test/UI deletion                            |

PersonB's independent checkout was detached at the same candidate. PersonA used
the supplied candidate branch. Both gates restored E2E-generated tracked
screenshots from `HEAD` and preserved generated artifacts outside the candidate.

## A / B Gate Agreement

| Fact                         | PersonA           | PersonB                       |
| ---------------------------- | ----------------- | ----------------------------- |
| Candidate                    | `d237c028...`     | `d237c028...`                 |
| Result                       | PASS              | PASS                          |
| Contract                     | `92/120/139/8`    | `92/120/139/8`                |
| Runtime / deferred           | `100 / 20`        | `100 / 20`                    |
| Runtime intersection / union | `0 / 120`         | `0 / 120`                     |
| S6 runtime operations        | `12 / 12`         | `12 / 12`                     |
| S7 runtime operations        | `5 / 5`           | `5 / 5`                       |
| DATA implemented / closed    | `47 / 43`         | `47 / 43`                     |
| Six SEARCH capabilities      | closed            | closed                        |
| `DOWN-001...003`             | `DATA`            | `DATA`                        |
| Canonical queues             | `13`              | `13`, live readiness verified |
| Mongo collections            | `23`              | `23`                          |
| Vector profiles              | `4`               | `4`; 3072 uses `halfvec`      |
| Dependency installation      | User install only | None                          |

PersonA and personB command matrices, exit codes, key results and per-command
output hashes are recorded in their respective evidence files.

## Commands

Both sides passed the required W2 gate:

| Gate               | PersonA | PersonB |
| ------------------ | ------- | ------- |
| Lint               | PASS    | PASS    |
| Format             | PASS    | PASS    |
| Typecheck          | PASS    | PASS    |
| Architecture       | PASS    | PASS    |
| Forbidden files    | PASS    | PASS    |
| License            | PASS    | PASS    |
| SBOM               | PASS    | PASS    |
| OpenAPI check      | PASS    | PASS    |
| Contract inventory | PASS    | PASS    |
| Runtime check      | PASS    | PASS    |
| Unit               | PASS    | PASS    |
| Contract           | PASS    | PASS    |
| Integration        | PASS    | PASS    |
| Tenant             | PASS    | PASS    |
| Concurrency        | PASS    | PASS    |
| Fault              | PASS    | PASS    |
| E2E                | PASS    | PASS    |
| Build              | PASS    | PASS    |
| Worker build       | PASS    | PASS    |
| Compose config     | PASS    | PASS    |

Gate counts:

- Unit: Turbo `22/22`; personB measured `286` tests.
- Contract: `18` files, `90` tests.
- Integration: Turbo `22/22`; service `23` files, `129` tests.
- Tenant: `7` files, `15` tests.
- Concurrency: `6` files, `13` tests.
- Fault: `8` files, `32` tests.
- E2E: `9` files, `41` tests.
- Build: `12/12`.
- Worker build: `11/11`.

OpenAPI generation was deterministic and left the tracked worktree clean. SBOM
generation left `artifacts/sbom.json` and `NOTICE` clean.

## Contract / Runtime / Capability

- Contract: `92 paths / 120 operations / 139 schemas / 8 parameters`.
- Runtime / deferred: `100 / 20`.
- Runtime/deferred intersection: `0`; union: `120`.
- S6 operations: `12 / 12` runtime.
- S7 operations: `5 / 5` runtime.
- Canonical queues: `13`.
- Mongo collections: `23`.
- Vector profiles: `768 / 1024 / 1536 / 3072`.
- Capability inventory: `73 total / 12 BASE / 57 DATA / 4 EXCLUDED`.
- W2 implemented / closed: `47 / 43`.
- Remaining DATA: `10`.

S7 runtime operations:

```text
API-SEARCH-SEMANTIC
API-SEARCH-FULLTEXT
API-SEARCH-HYBRID
API-SEARCH-MULTI
API-CITATION-GET
```

S7 completed nine implementation areas and closed six capabilities:

```text
SEARCH-001 SEARCH-002 SEARCH-004 SEARCH-005 SEARCH-007 SEARCH-009
```

`DOWN-001`, `DOWN-002`, `DOWN-003` and `DOWN-004` remain `DATA`. S10 owns final
API Key closure; no DOWN capability was claimed closed by W2.

## C1 / C2 / C3 / C6

C1:

- Real Mongo Outbox events were dispatched through Redis/BullMQ.
- Import parent/child jobs, duplicate delivery, terminal aggregation and failure
  propagation passed.

C2:

- S6 called the existing `S5ProcessingApplication`.
- Real MinIO, Mongo and PostgreSQL stored/read the processing artifacts.
- No second parser, chunker, QA implementation or fake success path was added.

C3:

- Real S6 index jobs wrote `knowledge_segments.indexes[]`, full-text versions
  and pgvector rows.
- S7 full-text/vector recall returned the same Source/Segment/index versions.
- Real final ACL hydration retained authorized rows and rejected stale or
  unauthorized candidates after recall.
- Multi-space hybrid retrieval returned two real S6-indexed Spaces with distinct
  citations and provenance.

C6:

- Search scope, tenant isolation, final ACL and citation reauthorization passed.
- Partial/degraded and failed-search audit behavior passed.
- No S10 API Key/admin lifecycle was implemented.

## Worker / S6 Preservation

- All 13 real BullMQ consumers reached `workers.ready`.
- Readiness marker appeared only after all 13 workers were ready; 13 canonical
  queue metadata keys matched.
- `SIGINT` removed readiness and left no worker process.
- Missing, duplicate, unknown and non-function handlers fail before startup.
- All 12 S6 operations, index worker, schemas, UI, tests, dependencies and
  generated artifacts remain in the candidate.
- All nine tracked S6 acceptance PNGs remain byte-identical.
- No Deferred fake-success handler or route was found.

## Dependencies

- Catalog entries: `159`.
- S6 exact direct dependencies: `6`.
- S7 exact direct dependencies: `21`.
- No 22nd S7 dependency.
- User install 1 lock SHA-256:
  `9e376a6d474a27c7a0abd4d4fcee7b3c6dafcea45663499655cb1570cebea844`.
- User install 2 final lock SHA-256:
  `31756b79284db42258c9140ca3c9c7ccb195d819633b05b6eaa3de7d0e59e72f`.
- Dependency-view archive bytes: `330234672`.
- Dependency-view SHA-256:
  `06dfb143539921d14245fdd81fdc6f180d9239d7c21192accda39e414d2878a7`.
- PersonA supplied the view; personB extracted it into its own worktree and did
  not run `pnpm install/add/update/remove`.
- Installed `node_modules/.pnpm/lock.yaml` matched the candidate lockfile.

## Test IDs

All S7 acceptance subsets PASS in both gates:

```text
TEST-SEARCH-001-BLOCK
TEST-SEARCH-002-BLOCK
TEST-SEARCH-004-BLOCK
TEST-SEARCH-005-BLOCK
TEST-SEARCH-007-BLOCK
TEST-SEARCH-009-BLOCK
TEST-X-SEARCH-REAUTH
TEST-X-TAG-FILTER-TYPES
TEST-DOWN-001-BLOCK S7 subset
TEST-DOWN-002-BLOCK S7 subset
TEST-DOWN-003-BLOCK S7 subset
TEST-X-FRONTEND-A11Y
ACC-UI-01...07
```

## UI

- S7 Search passed at `360`, `768` and `1200`.
- S6 Jobs, Segments and Segment Edit passed at the same widths.
- Blocking axe defects, horizontal overflow, unexpected console errors and
  failed runtime requests were zero.
- Search Markdown/GFM/KaTeX/Mermaid sanitization passed.
- Real Segment Edit conflict returned `409` and preserved submitted input.

## Real / Mock / External

`REAL_VERIFIED`:

- Mongo replica-set transactions, Redis/BullMQ, PostgreSQL/pgvector and MinIO;
- S5 processing through the existing local implementation;
- S6 Job/index output consumed by S7;
- final ACL, citation, multi-space, worker readiness and browser UI.

`FIXTURE_VERIFIED`:

- deterministic external model/OCR ports where credentials were unavailable;
- allowed deterministic rerank/fault behavior.

`EXTERNAL_UNVERIFIED`:

- production OCR, LLM, embedding and connector credentials;
- S10 API Key scope/lifecycle;
- production PDF rendering without optional `@napi-rs/canvas`.

## Risks

- CI, Review and PR Review are pending at the docs-only evidence commit.
- Five pre-existing release blockers remain pending legal review: `argparse`,
  `caniuse-lite`, `jschardet`, `pako` and `sax`.
- External providers and final API Key behavior remain unverified.
- Optional PDF canvas warnings appeared without `@napi-rs/canvas`; required W2
  tests and worker readiness still passed.

## Boundary

- No S4/S5/S6 test, UI asset or operation was removed.
- No Image/Deep, Synonym, API Key, ops page or old Dataset path was added.
- `DOWN-001...004` remain `DATA`; no Deferred fake success.
- S11 was not implemented or modified.

## Remaining Closure

1. Commit only `docs/acceptance/**` to create `evidenceCommitSha`.
2. Push that commit through the user/reviewer flow and run CI.
3. Review and PR Review bind the CI URL and read the same candidate/evidence
   facts.
