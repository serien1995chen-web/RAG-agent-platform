# S11 Provider Operations

## Scope

This runbook covers the S11 scoped profile `knowledge-usability-v1`:

- in scope: TokenDance AIProxy, Somark, TextIn, Doc2X and Feishu;
- deferred: Sangfor, Yuque and DingTalk.

Deferred providers must not be called by the scoped gate and must not be
reported as `REAL_VERIFIED`.

## Secret Input

Keep real values outside the repository, normally in
`~/.config/rag-agent-platform/s11-provider.env` with mode `0600`, or in the
Secret Manager used by the execution host. Load the file only into the test
process.

The required variable names are:

```text
S11_PROVIDER_MODE=real
S11_SCOPE_PROFILE=knowledge-usability-v1
S11_EVIDENCE_DIR
S11_AIPROXY_MODEL_MAPPING_APPROVED
AIPROXY_MODE
AIPROXY_BASE_URL
AIPROXY_API_TOKEN
S11_AIPROXY_LLM_MODEL
S11_AIPROXY_EMBEDDING_MODEL
S11_AIPROXY_RERANK_MODEL
S11_AIPROXY_VLM_MODEL
S11_AIPROXY_VISION_EMBEDDING_MODEL
AIPROXY_MODEL_PROFILE_JSON
S11_OCR_SOMARK_PROFILE_JSON
S11_OCR_TEXTIN_PROFILE_JSON
S11_OCR_DOC2X_PROFILE_JSON
S11_FEISHU_APP_ID
S11_FEISHU_APP_SECRET
S11_FEISHU_FOLDER_TOKEN
S11_FEISHU_DOC_1
S11_FEISHU_DOC_2
S11_FEISHU_DELETE_CASE_ID
S11_FEISHU_DELETE_PROPAGATION_VERIFIED=true
```

`AIPROXY_MODEL_PROFILE_JSON` is required when the catalog returns only model
IDs and does not supply role, capability and embedding-dimension metadata. It
is internal test/deployment configuration, not a public API or DTO.

Never print or persist tokens, app secrets, authorization headers, raw response
bodies, connection strings or object keys.

## Preflight

```bash
S11_SCOPE_PROFILE=knowledge-usability-v1 \
  node scripts/check-provider-inputs.mjs --json

S11_SCOPE_PROFILE=knowledge-usability-v1 \
AIPROXY_MODE=openai \
  node scripts/probe-aiproxy-catalog.mjs
```

The catalog probe reports configured IDs that are present in both the provider
catalog and the approved internal profile. Missing aliases require user
confirmation; do not substitute similar IDs automatically.

## Real Tests

```bash
S11_SCOPE_PROFILE=knowledge-usability-v1 pnpm test:provider:real
```

The runner writes sanitized evidence under `S11_EVIDENCE_DIR`:

- `t02-aiproxy.json`;
- `t02-ocr.json`;
- `t02-connectors.json`.
- `t02-provider-matrix.json`.

Evidence may include model IDs, endpoint host hashes, HTTP statuses, request
IDs, latency, page counts, usage and safe error codes. It may not include raw
provider bodies or credentials.

`t02-provider-matrix.json` is the safe manifest consumed by the matrix
generator. Its shape is:

```json
{
  "schemaVersion": 1,
  "candidateSha": "<sha-or-UNFROZEN>",
  "fixtureHash": "<sha256-or-null>",
  "files": {
    "aiproxy": "t02-aiproxy.json",
    "ocr": "t02-ocr.json",
    "connectors": "t02-connectors.json"
  }
}
```

The runner also records the last command, exit code and blocker count. It does
not record response bodies or credentials.

## Provider Matrix

```bash
S11_SCOPE_PROFILE=knowledge-usability-v1 \
S11_EVIDENCE_DIR=<outside-worktree-evidence> \
CANDIDATE_SHA=<candidate> \
S11_PROVIDER_FIXTURE_SHA256=<fixture-sha256> \
  node scripts/render-s11-evidence.mjs --provider-matrix
```

Only complete, candidate-bound evidence with five AIProxy roles, three OCR
results, Feishu read/delete propagation and zero deferred calls may emit
`REAL_VERIFIED`. Missing input keeps the matrix at `SCOPED_BLOCKED`.

## Failure Handling

- Missing scoped inputs: `SCOPED_BLOCKED`.
- `401`/`403`: do not retry; treat as auth or permission failure.
- `429`: follow the adapter retry policy; a terminal failure is rate limited.
- `5xx`/timeout: follow the provider policy and report attempts.
- Invalid provider schema: contract failure; never accept an empty success.
- Feishu folder token from `/wiki/...`: invalid for this gate; use a Drive
  `/drive/folder/<token>` token containing at least two readable docx files.
- Feishu delete propagation remains `SCOPED_BLOCKED` unless an operator supplies
  a controlled case ID and sets
  `S11_FEISHU_DELETE_PROPAGATION_VERIFIED=true`. A successful read test alone
  does not produce `REAL_VERIFIED`.

Yuque and DingTalk are guarded with `DEFERRED_BY_SCOPE`; a real call or mock
success in scoped real mode is a failure.
