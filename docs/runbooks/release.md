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
- licenseGateResult: `pnpm license:check` 退出码、`approved-2026-10-29` 与五项义务
- appImageRef / appDigest: 用户 build、push、retag 后的 production Registry 引用与 digest
- saasStatus: staging `/healthz`、`/readyz` 与真实 API 状态
- u15Status: `已接线` / `未接线`

## Pre-Release Checks

- Freeze scope, version, maintenance window, and expected write mode.
- Confirm backup requirement and keep the pre-migration backup until verification completes.
- Run migration dry-run and review the diff.
- Confirm rollback point and verification data points.
- Run `pnpm sbom:generate` and record the `artifacts/sbom.json` / `NOTICE` SHA-256 and component counts.
- Run `pnpm license:check` and record the exit code plus all five approved
  obligations and license text paths.
- Run `pnpm forbidden-files:check` and record the exit code.
- Keep `approvalSource` exactly as the user-transcribed legal approval; never
  invent a legal signer, signature, or approval file.

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
- 例外表：`scripts/license-obligations.data.json` 精确登记 `caniuse-lite@1.0.30001814`、`pako@1.0.11`、`sax@1.6.1`、`argparse@2.0.1`、`jschardet@3.1.1`，状态为 `approved-2026-10-29`。
- 批准来源：`用户于 2026-10-29 转述的法务批准`。该字段不是签名，不得扩展为批准人、批准文件或 SPDX 变更。
- 阻断行为：任一 name/version、父链、义务、许可证全文、NOTICE 渲染或依赖摘要不一致时，`license:check` 非 0；五条例外不得扩大。
- dev/build-only 白名单外许可证只做非阻塞审计，不阻断发布。
- 容器镜像白名单单独一套：mongo（SSPL）、redis（RSAL/SSPL）、minio（AGPL-3.0）、pgvector（PostgreSQL License）、AIProxy（供应链复核中）、app/worker（同仓库 INTERNAL 镜像）。

## 镜像 digest 登记表

| 服务       | registry/repository                                  | tag                            | digest（linux/amd64）                                                     | 许可证             |
| ---------- | ---------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------- | ------------------ |
| mongo      | `registry.cn-hangzhou.aliyuncs.com/fastgpt/mongo`    | `5.0.32`                       | `sha256:ab12670508974afbdf3bdc7dd39a201d228a73c9c13c70a684b9eedfb063dc3e` | SSPL               |
| redis      | `registry.cn-hangzhou.aliyuncs.com/fastgpt/redis`    | `7.2-alpine`                   | `sha256:2bf71743152d3ca631d358029d504fed349ea28179667acfa755dffb4b321e7c` | RSAL/SSPL          |
| pgvector   | `registry.cn-hangzhou.aliyuncs.com/fastgpt/pgvector` | `0.8.0-pg15`                   | `sha256:92be4ea0424cccf17003f5803d54448e2864ac27a70e6ac5d24b3d8b463c689c` | PostgreSQL License |
| minio      | `registry.cn-hangzhou.aliyuncs.com/fastgpt/minio`    | `RELEASE.2025-09-07T16-13-09Z` | `sha256:a63b19df59e6ec7c02ebba6e7a1097b7e032da7947b18db7ff67dae8e84fd44d` | AGPL-3.0           |
| aiproxy    | `registry.cn-hangzhou.aliyuncs.com/labring/aiproxy`  | `v0.7.3`                       | `sha256:da8d8394634eacdcf72533953c77c1e0ca3e28920545354dd20bdaa0aaa9ee4b` | UNKNOWN，待复核    |
| app/worker | 用户 production Registry                             | 用户确认 tag                   | `PENDING_RELEASE_EVIDENCE`（`DEFERRED_TO_PRODUCTION`）                    | INTERNAL           |

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

## 许可证批准（2026-10-29）

| 条目                        | 许可证        | 精确生产父链                                                                                     | 状态                | 义务                                            |
| --------------------------- | ------------- | ------------------------------------------------------------------------------------------------ | ------------------- | ----------------------------------------------- |
| `argparse@2.0.1`            | Python-2.0    | `packages/service → @apidevtools/json-schema-ref-parser@11.7.2 → js-yaml@4.3.2 → argparse@2.0.1` | approved-2026-10-29 | 全文、版权/历史 notice、随分发保留              |
| `caniuse-lite@1.0.30001814` | CC-BY-4.0     | `projects/app → next@16.3.0 → caniuse-lite@1.0.30001814`                                         | approved-2026-10-29 | 全文、指定 attribution、修改标明                |
| `jschardet@3.1.1`           | LGPL-2.1+     | `packages/parse → jschardet@3.1.1`                                                               | approved-2026-10-29 | 全文、notice、源码获取/安装路径、可替换与重链接 |
| `pako@1.0.11`               | MIT AND Zlib  | `projects/app → jszip@3.10.1 → pako@1.0.11`                                                      | approved-2026-10-29 | MIT 与 Zlib 两份全文、notice、修改标明          |
| `sax@1.6.1`                 | BlueOak-1.0.0 | `sdk/storage → ali-oss@6.23.0 → xml2js@0.6.2 → sax@1.6.1`                                        | approved-2026-10-29 | Blue Oak 全文、notice、随分发保留               |

批准来源固定为 `用户于 2026-10-29 转述的法务批准`。不记录姓名、签名或批准文件。

## S11 发布阻断项

以下外部事实仍阻止 S11 整阶段 PASS：

- 应用镜像 production Registry、tag、`sha256:64hex` digest 与 linux/amd64 证据未提供：`PENDING_RELEASE_EVIDENCE`，状态 `DEFERRED_TO_PRODUCTION`。
- AIProxy 镜像许可证与再分发条款仍为 `UNKNOWN`，需供应链复核。
- SaaS staging URL、受控 API Key、`/healthz`、`/readyz` 与真实 API 响应未提供：`TEST-X-SAAS-READY=DEFERRED_BY_SCOPE`。
- `NOTICE`、`artifacts/sbom.json` 与应用/worker 同源 digest 必须在最终 candidate 上重新生成并绑定。

`pnpm release:check --allow-missing-app` 在应用 digest 缺失时必须输出
`PENDING_RELEASE_EVIDENCE` 和 `DEFERRED_TO_PRODUCTION`，不得把 upstream
digest 当成 production digest。生产发布门禁仍必须补齐真实 digest 后才能 PASS。
