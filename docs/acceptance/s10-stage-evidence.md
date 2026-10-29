# S10 Stage Evidence

## Candidate

```text
candidateSha=c5d70d704fcdb9f29130fa64b8b027b6c24ad29f
baseSha=14a3b9e96fcab7b6a1f1e92ccdf4dc775719ee7d
branch=feat/kb-s10-ops-admin
owner=personB
worktreeStatus=clean-after-evidence-commit
```

## Stage Result

```text
openapiCounts=92/120/139/8
runtime=120
deferred=0
dataCapabilityClosed=57/57
excludedGuard=4/4
downEvidence=TEST-DOWN-001...004-BLOCK PASS
opsEvidence=TEST-OPS-001...005-BLOCK PASS
apiEvidence=TEST-API-003-BLOCK PASS
securityEvidence=TEST-X-SECRET-LEAK PASS
uiEvidence=TEST-X-FRONTEND-A11Y PASS
```

The stage suite passed:

```text
unit service 28 files / 125 tests
contract 21 files / 100 tests
security 5 files / 9 tests
integration service 33 files / 176 tests
tenant 10 files / 19 tests
concurrency 10 files / 19 tests
fault 12 files / 37 tests
E2E 16 files / 67 tests
```

## Key Artifacts

```text
test-results/s10-final/e2e.log
test-results/s10-final/integration.log
test-results/s10-final/fault.log
test-results/s10-final/security.log
test-results/s10-final/build.log
test-results/s10-final/build-workers.log
test-results/s10-final/compose-config.log
```

S10 screenshots use these prefixes:

```text
test-results/s10-ops-admin/s10-usage-{360,768,1200}.png
test-results/s10-ops-admin/s10-audit-{360,768,1200}.png
test-results/s10-ops-admin/s10-api-keys-{360,768,1200}.png
test-results/s10-ops-admin/s10-system-{360,768,1200}.png
```

Fixture: `test/fixtures/s10/api-key-hmac.secret`,
SHA-256 `e915ac661f8e729f8977f78172ef924cc066b3133442b779b0662dec4cf3e9c2`.

## External Status

- `REAL_VERIFIED`: Mongo replica set, Redis, PostgreSQL/pgvector, MinIO, canonical
  HTTP app and Chromium.
- `FIXTURE_VERIFIED`: S10 test model catalog and fixture pricing profile.
- `EXTERNAL_UNVERIFIED`: production AIProxy, IAM, connectors and shared usage
  service credentials.

## S11 / W4 Boundary

- S11 operations added by this stage: `0`.
- S10 operations removed or deferred: `0`.
- `test:performance`: not added.
- S11 real Provider, performance, recovery, image digest, final NOTICE/SBOM and
  final W4 report: not claimed.

## Risks

- W4 is not complete.
- The W4 personB gate is `BLOCKED` until personA supplies the candidate SHA, a
  pushed A branch name and the S10 merge SHA.
- All five pre-existing legal-review blockers remain unresolved and continue to
  block release, not S10 CI.
