# 架构基座验收记录

> 状态：实施中。只有最终命令证据全部写入后，才能将本文状态改为 PASS。

## 基线

| 项目      | 值                                         |
| --------- | ------------------------------------------ |
| 分支      | `feat/kb-architecture-baseline`            |
| 基线 main | `6505a74e3ee48c9471283191708566ed2c3cb772` |
| 目标设计  | `KnowledgeBase-System-Design.md` 1.0.0     |

## 阻断门禁

| ACC         | 命令/检查                          | 结果   | 退出码 | 证据 |
| ----------- | ---------------------------------- | ------ | -----: | ---- |
| ACC-GATE-01 | `pnpm lint`                        | 待执行 |      - | -    |
| ACC-GATE-02 | `pnpm format:check`                | 待执行 |      - | -    |
| ACC-GATE-03 | `pnpm typecheck`                   | 待执行 |      - | -    |
| ACC-GATE-04 | `pnpm architecture:check`          | 待执行 |      - | -    |
| ACC-GATE-05 | `pnpm forbidden-files:check`       | 待执行 |      - | -    |
| ACC-GATE-06 | `pnpm license:check`               | 待执行 |      - | -    |
| ACC-GATE-07 | `pnpm sbom:generate`               | 待执行 |      - | -    |
| ACC-GATE-08 | `pnpm openapi:check`               | 待执行 |      - | -    |
| ACC-GATE-09 | `pnpm knowledge:inventory`         | 待执行 |      - | -    |
| ACC-GATE-10 | `pnpm knowledge:check-runtime`     | 待执行 |      - | -    |
| ACC-GATE-11 | `pnpm test:unit`                   | 待执行 |      - | -    |
| ACC-GATE-12 | `pnpm test:contract`               | 待执行 |      - | -    |
| ACC-GATE-13 | `pnpm test:integration`            | 待执行 |      - | -    |
| ACC-GATE-14 | `pnpm test:tenant`                 | 待执行 |      - | -    |
| ACC-GATE-15 | `pnpm test:concurrency`            | 待执行 |      - | -    |
| ACC-GATE-16 | `pnpm test:fault`                  | 待执行 |      - | -    |
| ACC-GATE-17 | `pnpm test:e2e`                    | 待执行 |      - | -    |
| ACC-GATE-18 | `pnpm build && pnpm build:workers` | 待执行 |      - | -    |
| ACC-GATE-19 | Compose config                     | 待执行 |      - | -    |
| ACC-GATE-20 | Compose health                     | 待执行 |      - | -    |

## 外部状态

AIProxy、OCR、飞书、语雀和钉钉固定为 `EXTERNAL_UNVERIFIED`，不作为 PASS。

## 固定声明

本基座验收不代表 69 项知识库能力已完成，也不代表已达到 FastGPT 完整效果。
