# S8 Dependency Ledger

## Status

- Status: `INSTALLED_AND_LOCKFILE_VERIFIED`.
- Wave / stage / owner: `W3 / S8 / personB`.
- Branch: `feat/kb-s08-image-deep-rag`.
- Baseline: `13fa0e9be84edd33ea5cc5413d64282c126dd117`.
- Worktree: `/home/archer/RAG-agent-platform-w3-s8-personB`.
- User installation record: after the dependency-only pause, the user reported
  executing `pnpm install` in this S8 worktree. Installation timestamp and exit
  code were not supplied. The resulting lockfile and installed package state
  were verified by the Coding Agent.
- Agent installation record: none.
- Lockfile SHA-256:
  `a12d7b5430abfb013b6af52dbabc6d6a30c0b96b4f6f48d1a4d0454b3a691e7f`.
- Catalog count after declaration: `160`.
- Dependency ledger / audit count: `166 / 166`.

## Authorized Change

The only added runtime dependency is:

| Package            | Version | Catalog | Direct declaration          |
| ------------------ | ------- | ------- | --------------------------- |
| `react-photo-view` | `1.2.7` | exact   | `packages/web/package.json` |

The dependency is already recorded in the design ledger as owner stage `S8`,
scope `RUNTIME`, browser runtime usage `web-ui`. No other package, catalog key,
workspace link or version changed.

## User Install Gate

The user ran the only permitted installation command in the S8 worktree:

```text
cd /home/archer/RAG-agent-platform-w3-s8-personB
pnpm install
```

Timestamp: `NOT_SUPPLIED`. Exit code: `NOT_SUPPLIED`.

The Coding Agent did not execute `pnpm install/add/update/remove` and did not
edit `pnpm-lock.yaml`. The lockfile diff contains only the expected catalog,
importer, package and snapshot records for `react-photo-view@1.2.7`.

## Dependency Gate

| Command                                                 | Exit | Result                                                            |
| ------------------------------------------------------- | ---: | ----------------------------------------------------------------- |
| `node scripts/check-licenses.mjs --dependency-only`     |    0 | `166` ledger, `166` audit, `160` catalog, `12` workspace packages |
| `pnpm --filter @kb/web why react-photo-view -r`         |    0 | one dependency lineage: `@kb/web@0.1.0`                           |
| `pnpm --filter @kb/web list react-photo-view --depth 0` |    0 | `react-photo-view@1.2.7`                                          |
| `pnpm license:check`                                    |    0 | `160` catalog entries, `950` production components                |
| `git diff --check`                                      |    0 | no whitespace errors                                              |

## Post-install Verification

- `pnpm list -r --depth 0 --json` resolves `react-photo-view@1.2.7` once in
  `@kb/web`.
- `pnpm why react-photo-view -r` reports exactly one catalog lineage.
- `git diff -- pnpm-lock.yaml` contains only the expected catalog, importer,
  package and snapshot entries.
- `pnpm license:check` exits `0` with 160 catalog entries, 950 production npm
  components and the pre-existing five release blockers.

## Conclusion

The dependency installation gate is satisfied. Later S8 implementation proceeded
from this lockfile state.
