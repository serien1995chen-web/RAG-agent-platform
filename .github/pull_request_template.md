## 知识库架构基座检查

- [ ] 分支为 `feat/kb-architecture-baseline`，从干净 `origin/main` 创建
- [ ] 完整合同为 92 paths / 120 operations / 139 schemas
- [ ] runtime 恰好 46 operations，deferred 恰好 74 operations
- [ ] 23 个 `knowledge_*` 集合、4 个 pgvector profile、13 个 `knowledge-*` 队列
- [ ] runtime 不包含旧 Dataset route、旧 catch-all 或未批准 alias
- [ ] 不包含骨架占位码、临时错误码、200 假数据或空对象占位
- [ ] workspaceId、CAS、ACL revision、Job fencing 和 Outbox 已测试
- [ ] AIProxy、OCR、飞书、语雀、钉钉标记 `EXTERNAL_UNVERIFIED`
- [ ] deferred 功能未注册路由、未在 UI 显示为可用
- [ ] 全部门禁、真实基础设施、E2E、build、worker 和 Compose health 通过

## 证据

```text
command:
exit code:
key output:
```

实施 Codex 不执行 push、PR 创建、deploy 或 merge。PASS 后由用户自行合并。
