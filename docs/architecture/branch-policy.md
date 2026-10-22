# 分支与合并纪律

- 架构基座只使用 `feat/kb-architecture-baseline` 单一分支。
- 分支从干净的 `origin/main` 创建；已有同名分支必须先审计，不得 reset 或
  改写历史。
- 实施 Codex 可以创建本地 Work Package 提交，但不得 push、创建 PR、部署或
  merge。
- 合并前必须由第二位独立 Codex 只读复测全部阻断 ACC。
- 用户确认 PASS 后自行执行 GitHub merge。
