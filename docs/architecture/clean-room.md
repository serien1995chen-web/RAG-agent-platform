# Clean-room 与依赖合规

本仓库按目标设计独立实现。FastGPT 文件树只用于观察公开行为和消歧，不复制
源码、函数名、注释、Prompt、Schema 原文、i18n 文案、图标、字体、图片、
主题、部署文件、环境变量或品牌素材。

## 禁止项

- 任何 `@fastgpt-*`、`@fastgpt-sdk/*` 或 `@kb-sdk/*` 依赖。
- 来源仓库的源码片段、目录结构或品牌资产。
- 未在 catalog 中登记精确版本的第三方依赖。

## 依赖流程

1. 先更新 catalog 和包内 `catalog:` 声明。
2. 登记用途、许可证和 clean-room 理由。
3. 由用户在 WSL 执行安装命令并确认 lockfile 变化。
4. 实施 Codex 不得自行执行 `pnpm install/add/update/remove`。

## 门禁

```bash
pnpm forbidden-files:check
pnpm license:check
pnpm sbom:generate
```
