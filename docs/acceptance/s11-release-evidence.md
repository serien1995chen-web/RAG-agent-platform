# S11 Release Evidence (Phase 1)

## Status

- Result: `BLOCKED`.
- Wave / stage / owner: `W4 / S11 / personA`.
- Phase: `phase1 + post-rebase pre-install`.
- W4 base: `14a3b9e96fcab7b6a1f1e92ccdf4dc775719ee7d`.
- S10 merge SHA: `d7e38c71293a283cd6268605b5036e8ee5763c9a`; rebase completed.
- Candidate SHA: not frozen.
- Worktree: `/home/serien/RAG-agent-platform-s11` (clean at opening; post-rebase
  changes are implementation work, not candidate evidence).
- S11 worktree install: `PASS`; user `pnpm install` in this worktree exited 0
  and left the lockfile unchanged.

## Release Inputs

| Item                  | Value                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------- |
| approvalDate          | `2026-10-29`                                                                                  |
| approvalSource        | `用户于 2026-10-29 转述的法务批准`                                                            |
| license status        | `approved-2026-10-29`                                                                         |
| approved exceptions   | `argparse`, `caniuse-lite`, `jschardet`, `pako`, `sax`                                        |
| obligations           | full text, notice, attribution, source/relink and distribution obligations recorded per entry |
| NOTICE SHA-256        | `d9d5e614499d9e24af1aaa7dd8adefe8c88752cda99c919d7c3e0ecec081f195`                            |
| SBOM SHA-256          | `a49bfe6f5a35bae8b6faec2a305ac96cd367f3860bd68830f2838f28d1001ea5`                            |
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
