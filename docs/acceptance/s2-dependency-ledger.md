# S2 Dependency Ledger

## Result

- Catalog entries: 108
- Dependency ledger entries: 166
- Design entries: 164
- Approved test-only entries: 2
- S2-owned entries: 13
- Lockfile SHA-256 after user install: `13eb46427cfc97099fa677637209acc881aaba0b080469902dd3559fa788bf7a`

## S2 Declarations

| Package                         |  Version | Manifest         |
| ------------------------------- | -------: | ---------------- |
| `@aws-sdk/client-s3`            | 3.1113.0 | `sdk/storage`    |
| `@aws-sdk/lib-storage`          | 3.1113.0 | `sdk/storage`    |
| `@aws-sdk/s3-request-presigner` | 3.1113.0 | `sdk/storage`    |
| `ali-oss`                       |   6.23.0 | `sdk/storage`    |
| `cos-nodejs-sdk-v5`             |    3.0.0 | `sdk/storage`    |
| `es-toolkit`                    |   1.51.0 | `sdk/storage`    |
| `mime`                          |    4.1.0 | `sdk/storage`    |
| `@types/ali-oss`                |   6.23.3 | `sdk/storage`    |
| `archiver`                      |    7.0.1 | `projects/app`   |
| `jszip`                         |   3.10.1 | `projects/app`   |
| `@types/archiver`               |    6.0.4 | `projects/app`   |
| `@types/mime-types`             |    3.0.1 | `packages/parse` |
| `@types/yauzl`                  |   2.10.3 | `packages/parse` |

The user ran `cd ~/RAG-agent-platform && pnpm install`. The Coding Agent did not run package installation and did not edit `pnpm-lock.yaml`.

## Verification

- `pnpm test:contract`: PASS
- `pnpm license:check`: PASS, 108 catalog entries
- `pnpm sbom:generate`: PASS
- `pnpm build`: PASS
- `pnpm build:workers`: PASS

Three pre-existing `pending-legal-review` release blockers remain visible in `license:check`; they do not fail CI but continue to block release.
