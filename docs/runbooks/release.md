# Release Runbook

## Release State

`proposed -> migrated -> verified -> kept/rolled_back`

## Required Fields

- changeId
- runbookUri: `docs/runbooks/release.md`
- runbookVersion: `v1`
- rollbackInfo
- approvalRole
- sbomDigest: `artifacts/sbom.json` 的 SHA-256 与组件计数
- noticeDigest: `NOTICE` 的 SHA-256
- licenseGateResult: `pnpm license:check` 退出码与 `RELEASE BLOCKER` 清单
- u15Status: `已接线` / `未接线`

## Pre-Release Checks

- Freeze scope, version, maintenance window, and expected write mode.
- Confirm backup requirement and keep the pre-migration backup until verification completes.
- Run migration dry-run and review the diff.
- Confirm rollback point and verification data points.
- Run `pnpm sbom:generate` and record the `artifacts/sbom.json` / `NOTICE` SHA-256 and component counts.
- Run `pnpm license:check` and record the exit code plus every `RELEASE BLOCKER`.
- Run `pnpm forbidden-files:check` and record the exit code.
- Confirm that no `RELEASE BLOCKER` entry is described as legally approved.

## Release Steps

1. Record approval and changeId.
2. Enter the declared write mode.
3. Apply the migration.
4. Run count and reference checks.
5. Run reconcile dry-run.
6. Mark the release `verified` and either `kept` or `rolled_back`.

## Evidence Template

| Field               | Value |
| ------------------- | ----- |
| changeId            |       |
| version             |       |
| writeMode           |       |
| estimatedWindow     |       |
| rollbackWindow      |       |
| dryRunReport        |       |
| applyRunId          |       |
| verificationResult  |       |
| rollbackInfo        |       |
| approver            |       |
| sbomDigest          |       |
| noticeDigest        |       |
| licenseGateResult   |       |
| forbiddenGateResult |       |
| u15Status           |       |

## SBOM 与 NOTICE

| 项          | 值                                                                     |
| ----------- | ---------------------------------------------------------------------- |
| 生成命令    | `pnpm sbom:generate`                                                   |
| SBOM 路径   | `artifacts/sbom.json`（构建产物，按 D5-A 不入库）                      |
| NOTICE 路径 | `NOTICE`（由脚本生成并入库，禁止手工维护）                             |
| 四类组件    | 直接依赖、传递依赖、workspace 内部包、镜像组件（`kb:component-class`） |
| 可复现性    | 同一 commit 连续两次生成，除 `生成时间:`/`timestamp` 外无差异          |

## 许可证白名单与阻断规则

- npm 生产闭包白名单：MIT、Apache-2.0、BSD-2-Clause、BSD-3-Clause、ISC、0BSD；字体另允许 OFL-1.1。
- SPDX 判定：`OR` 表达式命中任一白名单分支即通过并记录所选分支（`jszip` → MIT）；`AND` 表达式要求全部分支命中（`pako` 的 Zlib 不命中）；裸 `BSD` 仅在包内 LICENSE 文本匹配时归一化为 BSD-2-Clause/BSD-3-Clause（`duck` → BSD-2-Clause）。
- N6-A 例外表（`check-licenses.mjs` 内置，精确 `name@version`）：`caniuse-lite@1.0.30001814`、`pako@1.0.11`、`sax@1.6.1`、`argparse@2.0.1`、`jschardet@3.1.1` 标记 `pending-legal-review` + `releaseBlocking: true`。
- 阻断行为：例外条目使 `license:check` 退出 0 但输出 `RELEASE BLOCKER`；任何未登记的非白名单 production 包使 `license:check` 非 0。
- dev/build-only 白名单外许可证只做非阻塞审计，不阻断发布。
- 容器镜像白名单单独一套：mongo（SSPL）、redis（RSAL/SSPL）、minio（AGPL-3.0）、pgvector（PostgreSQL License，N2-A 确认）。

## 镜像 digest 登记表

| 服务     | registry/repository                                  | tag                            | digest（linux/amd64）                                                     | 许可证             |
| -------- | ---------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------- | ------------------ |
| mongo    | `registry.cn-hangzhou.aliyuncs.com/fastgpt/mongo`    | `5.0.32`                       | `sha256:ab12670508974afbdf3bdc7dd39a201d228a73c9c13c70a684b9eedfb063dc3e` | SSPL               |
| redis    | `registry.cn-hangzhou.aliyuncs.com/fastgpt/redis`    | `7.2-alpine`                   | `sha256:2bf71743152d3ca631d358029d504fed349ea28179667acfa755dffb4b321e7c` | RSAL/SSPL          |
| pgvector | `registry.cn-hangzhou.aliyuncs.com/fastgpt/pgvector` | `0.8.0-pg15`                   | `sha256:92be4ea0424cccf17003f5803d54448e2864ac27a70e6ac5d24b3d8b463c689c` | PostgreSQL License |
| minio    | `registry.cn-hangzhou.aliyuncs.com/fastgpt/minio`    | `RELEASE.2025-09-07T16-13-09Z` | `sha256:a63b19df59e6ec7c02ebba6e7a1097b7e032da7947b18db7ff67dae8e84fd44d` | AGPL-3.0           |

digest 来源为设计文档 §6.3 + U-11 只读验证；Agent 不得执行 `docker pull` 现场取值。

## 门禁证据模板

| 门禁命令                     | 退出码 | 关键输出                                                    | 证据 |
| ---------------------------- | ------ | ----------------------------------------------------------- | ---- |
| `pnpm sbom:generate`         |        | 四类组件计数、`artifacts/sbom.json`/`NOTICE` 路径与 SHA-256 |      |
| `pnpm license:check`         |        | 白名单结论、`RELEASE BLOCKER` 清单（如有）                  |      |
| `pnpm forbidden-files:check` |        | `@fastgpt-*` 命中数（必须为 0）                             |      |

## U-15 接线状态

2026-10-15 P8-03 只读核验：**未接线**。依据：根 `package.json` 无 `prepare` 脚本、无 `husky`/`lint-staged` 依赖；仓库无 `.husky/` 目录。

未接线不视为通过：由用户执行 `pnpm add -Dw husky@8.0.3 lint-staged@16.4.0` 并接线后，把上方 `u15Status` 回填为 `已接线`。

## 发布阻塞项（2026-10-15 P8-03 实测）

**stage-closed ≠ 可对外发布。** 以下条目阻断对外发布，待法务复核；在法务给出批准人/日期前不得声明为已批准。

| 条目                        | 许可证         | 依赖父链                                                                                   | 状态                 | 阻断范围            |
| --------------------------- | -------------- | ------------------------------------------------------------------------------------------ | -------------------- | ------------------- |
| `caniuse-lite@1.0.30001814` | CC-BY-4.0      | `projects/app → next@16.3.0 → caniuse-lite`                                                | pending-legal-review | 发布阻断，CI 不阻断 |
| `pako@1.0.11`               | (MIT AND Zlib) | `packages/parse → mammoth@1.11.0 → jszip@3.10.2 → pako`                                    | pending-legal-review | 发布阻断，CI 不阻断 |
| `sax@1.6.1`                 | BlueOak-1.0.0  | `sdk/storage → minio@8.0.7 → xml2js@0.6.2 → sax`                                           | pending-legal-review | 发布阻断，CI 不阻断 |
| `argparse@2.0.1`            | Python-2.0     | `packages/service → @apidevtools/json-schema-ref-parser@11.7.2 → js-yaml@4.3.2 → argparse` | pending-legal-review | 发布阻断，CI 不阻断 |
| `jschardet@3.1.1`           | LGPL-2.1+      | `packages/parse → jschardet`                                                               | pending-legal-review | 发布阻断，CI 不阻断 |

已按 N6-A 规范化通过（非阻塞，附证据）：`duck@0.1.12` 的裸 `BSD` 由包内 LICENSE 文本归一化为 BSD-2-Clause；`jszip@3.10.2` 的 `(MIT OR GPL-3.0-or-later)` 按 MIT 分支通过。

dev/build-only 非阻塞审计（4 条）：`@csstools/color-helpers@5.1.0`（MIT-0）、`argparse@2.0.1`（Python-2.0）、`lightningcss@1.33.0`（MPL-2.0）、`minimatch@10.2.6`（BlueOak-1.0.0）。

P8-07 / personB 的 DoD 报告必须继承以上阻塞项。
