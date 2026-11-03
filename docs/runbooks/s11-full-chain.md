# S11 Full Business Chain

## Scope

This runbook executes the S11 Source to Job to Segment to Index to Citation to
Delete chain through the canonical HTTP API. It does not create operations,
routes, DTOs, collections, or queues.

## Required Inputs

- `S11_E2E_MODE=real`
- `S11_PROVIDER_MODE=real` and the provider variables listed by
  `scripts/check-provider-inputs.mjs`
- `KB_TEST_MONGO_URI`, `KB_TEST_REDIS_URL`, `KB_TEST_PG_URL`, and the
  `KB_TEST_S3_*` variables used by the existing E2E harness
- `S11_PUBLIC_TEST_URL` for the controlled public HTML page
- An isolated workspace and the S10 `API-APIKEY-CREATE` runtime operation

Missing variables produce `BLOCKED`. Mock transports are not accepted as real
Provider evidence.

## Procedure

1. Generate and verify fixtures:

   ```bash
   node test/fixtures/s11/generate-fixtures.mjs --write
   node test/fixtures/s11/generate-fixtures.mjs --check
   ```

2. Run the phase-1 harness:

   ```bash
   pnpm test:e2e -- s11-full-business-chain
   ```

3. After the S10 merge, run the real chain:

   ```bash
   S11_E2E_MODE=real pnpm test:e2e -- s11-full-business-chain
   ```

4. Retain safe JSON evidence outside the worktree through
   `scripts/collect-s11-evidence.mjs`.

## Safety

- Record only variable names, provider, model ID, requestId, status, latency,
  page count, usage, safe error code, and hashes.
- Never persist provider response bodies, credentials, cookies, authorization
  headers, connection strings, or object keys.
- Stop on a non-isolated workspace, duplicate Source or Segment facts, a
  pending Outbox event, or any child Job that remains non-terminal.
