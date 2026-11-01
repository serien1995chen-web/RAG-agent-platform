# S11 Release Evidence (Phase 1)

## Status

- Result: `BLOCKED`.
- Wave / stage / owner: `W4 / S11 / personA`.
- Phase: `phase1` pre-hardening only.
- W4 base: `14a3b9e96fcab7b6a1f1e92ccdf4dc775719ee7d`.
- S10 merge SHA: not provided; rebase not run.
- Candidate SHA: not frozen.
- Worktree: `/home/serien/RAG-agent-platform-s11` (clean at opening; current
  uncommitted phase1 changes are implementation work, not candidate evidence).

## Release Inputs

| Item                  | Value                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------- |
| approvalDate          | `2026-10-29`                                                                                  |
| approvalSource        | `用户于 2026-10-29 转述的法务批准`                                                            |
| license status        | `approved-2026-10-29`                                                                         |
| approved exceptions   | `argparse`, `caniuse-lite`, `jschardet`, `pako`, `sax`                                        |
| obligations           | full text, notice, attribution, source/relink and distribution obligations recorded per entry |
| NOTICE SHA-256        | `edd810c160cd0a57fb14119a1211431415f681658a78e5b702c0b02042735c09`                            |
| SBOM SHA-256          | `81166ca23652a67a472eafea35b6e950461b19610329da72f3a14e7dd7ddce50`                            |
| SBOM image components | 6 classes; app/worker shared reference is pending                                             |
| app/worker digest     | `RELEASE_BLOCKED_APP_IMAGE`                                                                   |
| SaaS staging          | `BLOCKED`; URL/token not provided                                                             |

## Static Release Gates

| Gate                                                        | Result  | Evidence                                                           |
| ----------------------------------------------------------- | ------- | ------------------------------------------------------------------ |
| `node scripts/generate-sbom.mjs`                            | PASS    | `NOTICE` and `artifacts/sbom.json` regenerated; 6 image components |
| `node scripts/check-licenses.mjs`                           | PASS    | approved-2026-10-29; 5 obligations; no pending status              |
| `node scripts/check-release-images.mjs --allow-missing-app` | BLOCKED | third-party digests match; `RELEASE_BLOCKED_APP_IMAGE`             |
| `docker compose -f deploy/docker-compose.yml config`        | PASS    | base config accepted                                               |
| release Compose with `--profile aiproxy`                    | PASS    | profile config accepted; no container start                        |

No release PASS or W4 completion is claimed.
