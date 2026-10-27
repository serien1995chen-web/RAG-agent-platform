# S6 Dependency Ledger

## Status

- Stage: `S6 / personB`.
- Branch: `feat/kb-s06-job-index`.
- Candidate SHA: `c398593db550e6d4832a24642b368f11bac22ff8`.
- W2 baseline: `87ba3bdea3d7daf3e738a04998b80b49cbf7a77b`.
- User installation record: `pnpm install` was executed by the user.
- Agent installation record: none.
- Lockfile SHA-256:
  `3c7c558ad9b930ec6c23aef17e4154b9e20fa134075fe7401b1cee5f201995f1`.
- Catalog count: `138`.
- Dependency ledger / audit count: `166 / 166`.

## Direct Declarations

| Package            | Exact version | Section         | Direct workspace                     |
| ------------------ | ------------- | --------------- | ------------------------------------ |
| `cron-parser`      | `4.9.0`       | dependencies    | `packages/contracts`                 |
| `nanoid`           | `5.1.5`       | dependencies    | `packages/contracts`, `projects/app` |
| `node-cron`        | `3.0.3`       | dependencies    | `packages/service`                   |
| `p-limit`          | `7.2.0`       | dependencies    | `packages/service`, `projects/app`   |
| `@types/node-cron` | `3.0.11`      | devDependencies | `packages/service`                   |
| `@types/pg`        | `8.11.11`     | devDependencies | `packages/service`                   |

All declarations use the workspace catalog. This produces eight direct
declarations for the six packages. No dependency was added, removed or updated
by the Coding Agent.

## Lockfile Resolution

The lockfile contains the exact resolved versions:

```text
cron-parser@4.9.0
nanoid@5.1.5
node-cron@3.0.3
p-limit@7.2.0
@types/node-cron@3.0.11
@types/pg@8.11.11
```

The previous local `packages/service/src/types/pg.d.ts` shim was removed after
`@types/pg` became an explicit direct dependency. No workspace link was added or
changed.

## Verification

| Command                         | Exit | Result                                                                    |
| ------------------------------- | ---: | ------------------------------------------------------------------------- |
| `pnpm test:contract`            |    0 | dependency gate and ledger assertions passed                              |
| `pnpm license:check`            |    0 | 12 workspace packages, 138 catalog entries, 689 production npm components |
| `pnpm sbom:generate`            |    0 | 138 direct, 1407 transitive, 12 workspace and 4 image components          |
| `pnpm list -r --depth 0 --json` |    0 | direct dependency closure inspected without installing                    |

`license:check` reports five release blockers pending legal review. They block a
production release but do not fail the S6 branch gate.

## Conclusion

Dependency state is consistent with the S6 Plan. The branch status remains
`S6_BRANCH_PASS_PENDING_S7`.
