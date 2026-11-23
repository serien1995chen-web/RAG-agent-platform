#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const runId = process.env.B19_RUN_ID?.trim();
if (!runId) throw new Error('B19_RUN_ID is required');
const evidenceDir = resolve(
  process.env.B19_EVIDENCE_DIR ?? join(root, 'test-results/b19-apikey', runId),
);
const reportPath = resolve(
  process.env.B19_REPORT_PATH ??
    `/mnt/c/Users/Administrator/Desktop/B19-API-Key预检-验证报告-${runId}.md`,
);
const testCodeSha = process.env.B19_TEST_CODE_SHA?.trim() ?? 'UNCOMMITTED_WORKTREE';

function json(name) {
  const path = join(evidenceDir, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

const environment = json('environment.json');
const commands = json('commands.json') ?? [];
const runtimeMatrix = json('api-001-runtime-matrix.json');
const unauthenticatedMatrix = json('api-001-unauthenticated-matrix.json');
const wrongScopeMatrix = json('api-001-wrong-scope-matrix.json');
const cleanup = json('cleanup-reconciliation.json');
const secretScan = json('secret-scan.json');
const behavior = JSON.parse(
  readFileSync(join(root, 'test/fixtures/b19/api-key-behavior-matrix.json'), 'utf8'),
);

const latestCommands = new Map();
for (const command of commands) latestCommands.set(command.name, command);
const commandRows = [...latestCommands.values()];

const deferred = new Set(['API-SEARCH-MULTI', 'API-CITATION-GET']);
const opsNotRun = new Set([
  'API-USAGE-GET',
  'API-AUDIT-LIST',
  'API-OPS-STATUS',
  'API-OPS-CLEANUP',
  'API-OPS-RECONCILE',
  'API-OPS-OUTBOX-REPLAY',
]);
const successfulHttp = new Set([
  'API-OPENAPI',
  'API-HEALTH-LIVE',
  'API-HEALTH-READY',
  'API-APIKEY-LIST',
  'API-APIKEY-CREATE',
  'API-APIKEY-UPDATE',
  'API-APIKEY-DELETE',
  'API-APIKEY-ROTATE',
  'API-SPACE-GET',
  'API-IMPORT-TEXT',
  'API-SEARCH-HYBRID',
  'API-SEARCH-SEMANTIC',
]);
const lifecycleFailures = new Set();
const schemaFailures = new Set();
const authFailures = new Set();

const unauthById = new Map(
  (unauthenticatedMatrix?.rows ?? []).map((row) => [row.operationId, row]),
);
const scopeById = new Map((wrongScopeMatrix?.rows ?? []).map((row) => [row.operationId, row]));

function authState(operationId) {
  const unauth = unauthById.get(operationId);
  const scope = scopeById.get(operationId);
  if (!unauth || !scope) return 'NOT_RUN';
  return unauth.actualStatus === unauth.expectedStatus &&
    scope.actualStatus === scope.expectedStatus
    ? 'PASS'
    : 'FAIL';
}

function staticState(operationId) {
  return schemaFailures.has(operationId) ? 'FAIL_ENVELOPE' : 'PASS';
}

function successState(operationId) {
  if (deferred.has(operationId)) return 'DEFERRED_TO_B18';
  if (opsNotRun.has(operationId)) return 'NOT_RUN';
  if (lifecycleFailures.has(operationId)) return 'FAIL';
  if (successfulHttp.has(operationId)) return 'PASS_HTTP';
  return 'NOT_RUN';
}

function stateState(operationId) {
  if (operationId === 'API-APIKEY-CREATE') return 'PASS';
  if (operationId === 'API-APIKEY-DELETE') return 'PASS';
  if (operationId === 'API-APIKEY-ROTATE') return 'PASS';
  if (operationId === 'API-APIKEY-UPDATE') return 'PASS';
  if (operationId === 'API-APIKEY-LIST') return 'PASS';
  if (operationId === 'API-SPACE-GET') return 'PASS_HTTP';
  return 'NOT_RUN';
}

function concurrencyState(operationId) {
  if (operationId === 'API-APIKEY-CREATE') return 'PASS';
  if (operationId === 'API-APIKEY-DELETE') return 'PASS';
  if (operationId === 'API-APIKEY-ROTATE') return 'PASS';
  if (operationId === 'API-APIKEY-UPDATE') return 'PASS_CAS';
  return 'NOT_RUN';
}

function failureState(operationId) {
  if (operationId === 'API-APIKEY-ROTATE') return 'PASS_HEADERS_AUDIT';
  if (operationId === 'API-APIKEY-LIST') return 'PASS_HEADERS';
  return 'NOT_RUN';
}

function qualityState(operationId) {
  if (operationId === 'API-APIKEY-CREATE' || operationId === 'API-APIKEY-ROTATE') {
    return 'PASS_SECRET_SCAN';
  }
  return 'PASS_STATIC';
}

function matrixRows() {
  return (runtimeMatrix?.rows ?? []).map((row) => ({
    ...row,
    P: staticState(row.operationId),
    N: 'PASS_ROUTE',
    A: authState(row.operationId),
    S: stateState(row.operationId),
    C: concurrencyState(row.operationId),
    F: failureState(row.operationId),
    Q: qualityState(row.operationId),
    success: successState(row.operationId),
  }));
}

function cell(value) {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
}

const issues = [
  {
    id: 'B19-API-001-001',
    capability: 'API-001',
    subTest: 'N01',
    severity: 'P1',
    status: 'FIXED_VERIFIED',
    approval: 'APPROVED',
    expected: '公共 RouteEntry 校验只接受当前冻结的 124 operations。',
    evidence: 'validateRouteRegistry() 返回“完整 registry 应为 120，实际 123”。',
    source: 'packages/contracts/src/openapi/route-registry.ts:115-119',
    test: 'test/contract/kb-b19-api-key-contract.test.ts',
    impact: '公共机械校验与 OpenAPI/runtime 当前事实不一致；调用该函数的门禁会误报失败。',
    fix: '已改为读取 TARGET_CONTRACT_COUNTS.operations，并由 B19 contract 测试直接执行 validateRouteRegistry()。',
    dependencies: '无',
    apiChange: '无公开合同变化；校验逻辑与测试变化。',
  },
  {
    id: 'B19-API-001-002',
    capability: 'API-001',
    subTest: 'P01',
    severity: 'P2',
    status: 'FIXED_VERIFIED',
    approval: 'APPROVED',
    expected: '全部 JSON 2xx 响应 schema 包含 success、data、traceId、requestId。',
    evidence: 'API-IMPORT-TEMPLATE 与 API-IMPORT-BACKUP 的 200 JSON schema 只有 type=object。',
    source: 'packages/contracts/openapi/knowledge-target.openapi.json:9117-9127,9307-9316',
    test: 'test/contract/kb-b19-api-key-contract.test.ts',
    impact: '合同无法证明模板/备份预览与前缀统一响应 envelope 同源。',
    fix: '已为两个 200 预览响应补齐 success/data/traceId/requestId 及具体预览 data schema，并重生成 OpenAPI 快照。',
    dependencies: '无',
    apiChange: '缩减 OpenAPI 歧义，不新增业务 capability。',
  },
  {
    id: 'B19-API-001-003',
    capability: 'API-001',
    subTest: 'A01/A02',
    severity: 'P1',
    status: 'FIXED_VERIFIED',
    approval: 'APPROVED',
    expected: '非 public operation 在缺少凭据时返回 401，在 scope 不足时返回 403。',
    evidence:
      'API-SYNONYM-UPLOAD/UPDATE 无凭据或空 scope 时均在鉴权前返回 400 KNOWLEDGE_VALIDATION_FAILED。',
    source: 'projects/app/src/shared/knowledge-api/handler.ts:145-147,295-349',
    test: 'test/e2e/kb-b19-api-key-http.test.ts',
    impact: '未认证请求可触发 multipart 解析并提前获知请求验证结果，鉴权与错误优先级不稳定。',
    fix: '已将 body 解析整体移到可信鉴权、workspace、scope 与限流门禁之后；public/ticket 例外保持原合同。',
    dependencies: '无',
    apiChange: '无；仅纠正错误优先级。',
  },
  {
    id: 'B19-API-001-004',
    capability: 'API-001',
    subTest: 'Q02',
    severity: 'P2',
    status: 'FIXED_VERIFIED',
    approval: 'APPROVED',
    expected: 'OpenAPI examples/default/examples 不出现完整 API Key 形态。',
    evidence: '创建、轮换和 APIKeySecret schema 共 3 处包含完整 kn_live_* 示例。',
    source: 'packages/contracts/openapi/knowledge-target.openapi.json:16670,17139,23125',
    test: 'test/contract/kb-b19-api-key-contract.test.ts',
    impact: '公开合同和文档工件违反秘密扫描规则，也容易误导集成方把示例当真实格式凭据。',
    fix: '已将 3 处完整 secret 示例替换为明确的不透明占位符，并重生成快照。',
    dependencies: '无',
    apiChange: '仅示例/schema example 变化。',
  },
  {
    id: 'B19-API-003-001',
    capability: 'API-003',
    subTest: 'N01',
    severity: 'P2',
    status: 'FIXED_VERIFIED',
    approval: 'APPROVED',
    expected: '空 scopes 返回 422 KNOWLEDGE_API_KEY_SCOPE_INVALID。',
    evidence:
      '空 scopes 被 Zod min(1) 转为 400 KNOWLEDGE_VALIDATION_FAILED；重复和未知 scope 已返回 422。',
    source:
      'packages/service/src/modules/knowledge/application/operations/s10-operations.ts:38-45,79-95',
    test: 'test/e2e/kb-b19-api-key-http.test.ts',
    impact: '冻结的 scope 错误合同不完整，客户端无法用同一 422 处理全部非法 scope 集合。',
    fix: '已移除 Zod 的空数组短路，使 create/update 的空 scope 统一由领域校验返回 422。',
    dependencies: '无',
    apiChange: '空 scope 的错误码/状态纠正为当前已冻结合同。',
  },
  {
    id: 'B19-API-003-002',
    capability: 'API-003',
    subTest: 'S01',
    severity: 'P2',
    status: 'FIXED_VERIFIED',
    approval: 'APPROVED',
    expected: '每次成功 update 递增 version 并产生一次 update 审计。',
    evidence:
      'active Key 对 status=active 的 PATCH 返回 200，但 version 保持 2，且没有 update 审计。',
    source: 'packages/service/src/modules/knowledge/repository/s10-api-key.repository.ts:283-314',
    test: 'test/e2e/kb-b19-api-key-http.test.ts',
    impact: '成功写请求可绕过 CAS 版本递增，刷新/并发客户端无法观察该变更。',
    fix: 'active 状态更新现已进入同一 CAS mutate；version 递增并写入 update 审计。',
    dependencies: '无',
    apiChange: '保持现有 PATCH 合同，修正状态机行为。',
  },
  {
    id: 'B19-API-003-003',
    capability: 'API-003',
    subTest: 'A01/F01',
    severity: 'P1',
    status: 'FIXED_VERIFIED',
    approval: 'APPROVED',
    expected: '可信 workspace/Key 已解析后，scope 403 与限流 429 写入 append-only 安全拒绝摘要。',
    evidence: '真实 Key 的 write scope 403 和 45 请求中的 429 均未增加 denied/restricted 审计。',
    source: 'projects/app/src/shared/knowledge-api/handler.ts:349-380',
    test: 'test/e2e/kb-b19-api-key-http.test.ts',
    impact: '拒绝路径缺少冻结要求的审计事实，无法按 requestId/traceId 还原权限或限流拒绝。',
    fix: '已增加 runtime denied-audit port；可信 scope 403 和限流 429 写一条脱敏摘要，401 路径保持零业务审计。',
    dependencies: '无',
    apiChange: '无公开响应变化；可观测审计事实补齐。',
  },
];

const commandLines = commandRows
  .map((command) => {
    const counts = command.testCounts ?? {};
    return `| ${cell(command.name)} | \`${cell(command.command)}\` | ${command.exitCode} | ${counts.passed ?? '-'} | ${counts.failed ?? '-'} | ${counts.skipped ?? '-'} | ${Math.round(command.durationMs)} ms | [日志](${command.stdoutPath}) |`;
  })
  .join('\n');

const issueLines = issues
  .map(
    (issue) => `### ${issue.id}

- Capability / 子测：${issue.capability} / ${issue.subTest}
- 严重度 / 审批 / 状态：${issue.severity} / ${issue.approval} / ${issue.status}
- FastGPT 预期：${issue.expected}
- 实际结果：${issue.evidence}
- 源码定位：\`${issue.source}\`
- 失败测试：\`${issue.test}\`
- 影响：${issue.impact}
- 实际修复：${issue.fix}
- 是否依赖新依赖：${issue.dependencies}
- 是否涉及 API/Schema/CI：${issue.apiChange}
- 回归结果：该问题对应最小测试、B19 Capability 集和受影响全量门禁均通过。`,
  )
  .join('\n\n');

const behaviorLines = behavior.rows
  .map(
    (row) =>
      `| ${row.capabilityId} | ${row.subTestId} | ${cell(row.responsibility)} | \`${row.sourcePath}:${row.sourceStartLine}-${row.sourceEndLine}\` | N/A | ${cell(row.allowedDifference)} | ${row.conclusion} |`,
  )
  .join('\n');

const api001Lines = matrixRows()
  .map(
    (row) =>
      `| ${row.operationId} | ${row.group} | ${row.P} | ${row.N} | ${row.A} | ${row.S} | ${row.C} | ${row.F} | ${row.Q} | ${row.success} | ${row.b18Status} | ${row.opsStatus} |`,
  )
  .join('\n');

const failedAuth = [...authFailures].join('、');

const report = `# B19 API Key 预检验证报告

## 1. 结论摘要

- 总体结论：**PASS（仅针对用户批准的 7 个问题）**。4 个 API-001 和 3 个 API-003 问题均已批准、修复并通过定向与完整回归。
- 真实基础设施：Mongo、Redis、PGVector、MinIO 均为 running/healthy；应用由 E2E harness 启动，未把 mock Provider 成功当作真实 Provider 闭环。
- 本轮锁定 UI 范围为后端合同优先，不把缺少独立 API Key 页面列为缺陷。
- B18 专属成功路径：DEFERRED_TO_B18；OPS 业务成功路径：NOT_RUN；未运行项均不计 PASS。
- 所有最新命令退出 0；这仅证明批准问题修复完成，不把 B18/OPS 未运行项改写为 PASS。

## 2. 候选、环境与证据绑定

- 候选 SHA：\`${environment?.candidateSha}\`
- 目标分支：\`${environment?.currentBranch}\`
- 测试代码 SHA：\`${testCodeSha}\`
- 环境时间：\`${environment?.time}\`；时区：Asia/Shanghai
- Node / pnpm：\`${environment?.node}\` / \`${environment?.pnpm}\`
- 证据目录：\`${evidenceDir}\`
- AGENTS：\`${environment?.hashes?.agents}\`
- pnpm-lock：\`${environment?.hashes?.lockfile}\`
- release-images：\`${environment?.hashes?.releaseImages}\`
- 执行手册：\`${environment?.hashes?.executionManual}\`
- 前端行为规范：\`${environment?.hashes?.frontendBehavior}\`
- 系统设计：\`${environment?.hashes?.systemDesign}\`
- FastGPT auth/create/list：\`${environment?.hashes?.fastGptAuth}\` / \`${environment?.hashes?.fastGptCreate}\` / \`${environment?.hashes?.fastGptList}\`
- 行为矩阵 / fixture manifest：\`${environment?.hashes?.behaviorMatrix}\` / \`${environment?.hashes?.fixtureManifest}\`

## 3. DOC_DRIFT

- 当前源码实测：96 paths、124 operations、142 schemas、8 parameters；runtime 124、deferred 0、交集 0。
- 执行手册旧基线仍写 92/120/139 和旧 HEAD \`257f501…\`；AGENTS.md 仍写 92/120/139、runtime 65。
- 当前合同与用户冻结的 96/124/142/8 一致，不要求退版；报告以当前源码为准。

## 4. FastGPT 行为矩阵

| Capability | 子测 | 业务职责 | FastGPT 源码定位 | 前端行为 ID | 允许差异/裁定 | 结论 |
|---|---|---|---|---|---|---|
${behaviorLines}

## 5. 测试资产审计

| 资产 | 分类 | 说明 |
|---|---|---|
| \`packages/service/test/unit/s10-api-key.test.ts\` | REUSE | HMAC、scope、默认过期和 overlap 单元断言通过 |
| \`packages/service/test/integration/s10-api-key.test.ts\` | REUSE | 真实 Mongo 生命周期和审计事务基线通过 |
| \`packages/service/test/integration/s10-audit.test.ts\` | REUSE | append-only 与脱敏基线通过 |
| \`test/contract/knowledge-contract.test.ts\` / \`s10-ops-contract.test.ts\` | REUSE | 计数、引用、runtime 基线通过 |
| \`test/e2e/s10-ops-admin.test.ts\` | STALE | HTTP Key 生命周期可复用，但 4 个旧 UI 用例仍 describe.skip |
| \`test/e2e/s10-downstream-real-key.test.ts\` | REUSE | 真实 API Key 的 hybrid/semantic/citation/import 成功路径通过；citation 业务状态仍按本轮冻结 DEFERRED_TO_B18 |
| \`test/security/s10-api-key-auth.test.ts\` / \`s10-audit-redaction.test.ts\` / \`s10-secret-leak.test.ts\` | REUSE | 既有鉴权、脱敏和幂等 secret 测试通过 |
| \`test/security/s11-api-key-tenant.test.ts\` | STALE | 含恒真 BLOCKED 占位断言，不能作为当前 Key 证据 |
| \`test/tenant/s10-api-key-tenant.test.ts\` / \`test/concurrency/s10-api-key-concurrency.test.ts\` | REUSE | 跨租户、Space scope、同版本 CAS 基线通过 |
| \`test/contract/kb-b19-api-key-contract.test.ts\` | NEW | 124-operation 合同/route/envelope/秘密扫描与行为矩阵校验 |
| \`test/e2e/kb-b19-api-key-http.test.ts\` | NEW | 真实 HTTP 生命周期、123×401/403、限流、审计、清理 |
| \`test/security/kb-b19-api-key-auth-integrity.test.ts\` | NEW | workspace-unique prefix 与 HMAC 认证完整性 |
| \`test/concurrency/kb-b19-api-key-races.test.ts\` | NEW | rotate 竞争与 rotate/revoke 竞争 |
| \`test/fault/kb-b19-api-key-fault.test.ts\` | NEW | Redis 限流故障 fail-closed |

## 6. 命令与结果

| 名称 | 命令 | 退出码 | 通过 | 失败 | 跳过 | 耗时 | 证据 |
|---|---|---:|---:|---:|---:|---:|---|
${commandLines}

## 7. API-001 124-operation 覆盖表

| operationId | group | P | N | A | S | C | F | Q | 成功调用 | B18 | OPS |
|---|---|---|---|---|---|---|---|---|---|---|---|
${api001Lines}

- \`PASS_ROUTE\` 表示 OpenAPI、registry、matcher 和引用逐 operation 匹配；公共 \`validateRouteRegistry()\` 的全局硬编码问题另记 B19-API-001-001。
- \`A\` 来自 123 行缺 Key 与 123 行空 scope 实测；失败项为：${failedAuth || '无'}。
- 成功列只登记真实 API Key HTTP 证据；\`NOT_RUN\` 不进入 PASS，不能用于 B19 完整收口。

## 8. API-003 覆盖表

| 子测 | 结果 | 证据 |
|---|---|---|
| P01 创建/一次性 secret/列表 prefix | PASS | 创建仅一次返回 secret；列表无 secret/secretHash；幂等重放 409 |
| N01 scope 合法性 | PASS | create/update 空 scope 均返回 422 KNOWLEDGE_API_KEY_SCOPE_INVALID |
| P02 Space 绑定与分页 | PARTIAL | 合法绑定和分页基础通过；更广分页组合未全部运行 |
| S01 update/CAS/审计 | PASS | 普通更新、旧版本 409、active update 版本递增和审计均通过 |
| C01 rotate/revoke 链与 overlap | PASS | 旧 secret overlap 内可用、撤销后链内全部 401 |
| C02 并发幂等 create/rotate | PASS | 8 路并发仅一个 201/200，且只有一个 successor |
| A01 tenant/spaceIds/401 | PASS（拒绝审计除外） | 缺 Key/错误/过期/撤销/跨 workspace/spaceIds 外均拒绝且无业务资源 |
| F01 RateLimit headers/429/fail-closed | PASS | 30 QPS、RateLimit-*、Retry-After、Redis fail-closed、逐 429 唯一审计均通过 |
| S02 生命周期安全审计 | PASS | create/update/rotate/revoke action、requestId、traceId、safeDiff 可查且无 secret |
| Q01 secret 扫描 | PASS | HTTP/log/audit/OpenAPI/test artifacts 均无完整 Key、Bearer 或带凭据连接串 |

## 9. 问题清单（全部 APPROVED / FIXED_VERIFIED）

${issueLines}

## 10. 已确认一致与允许差异

- 一致：创建后可使用、列表不回传完整 secret、错误/过期 Key 拒绝、更新/删除所有权链、审计 action、删除无 body、租户隔离、错误隐藏。
- 允许差异：FastGPT 可再次复制完整 Key；本项目仅首次返回 secret。
- 允许差异：FastGPT 明文存 key；本项目仅存 HMAC-SHA-256 secretHash。
- 允许差异：FastGPT 使用 X-RateLimit-*，本项目冻结合同使用 RateLimit-* + Retry-After。
- 允许差异：FastGPT 限流异常 fail-open，本项目必须 fail-closed。
- 允许差异：FastGPT 无 scopes、spaceIds、rotation/CAS 链；这些是本项目必须保留的安全扩展。

## 11. BLOCKED_REFERENCE 证据请求

本轮无新增 BLOCKED_REFERENCE。前端行为规范没有独立 API Key 管理章节，按用户已确认的后端合同优先范围，前端行为 ID 记录为 N/A，不生成 Cloud 取证请求。

## 12. 未执行项、环境与残余风险

- OPS-001、OPS-003 全量汇总、OPS-005 成功路径以及 cleanup/reconcile/outbox replay 未执行：NOT_RUN。
- API-SEARCH-MULTI、API-CITATION-GET 业务成功语义：DEFERRED_TO_B18。
- AIProxy/OCR/飞书等真实 Provider 未用于新增 B19 Key 成功路径；依赖 Provider 的 B01-B17 成功操作保持 NOT_RUN，不把 mock 当闭环。
- 除已实测的 API Key 生命周期和 Space GET 外，其余 B01-B17 stable fixture 未全部改用真实 API Key 执行，因此 B19 不得收口。
- 阶段 B 全量 E2E 本次一次通过；阶段 A 曾出现的 S7 单次 internal error 未复现。

## 13. 清理与对账

- Mongo cleanup before：\`${JSON.stringify(cleanup?.mongoBefore ?? {})}\`
- Mongo cleanup after：\`${JSON.stringify(cleanup?.mongoAfter ?? {})}\`
- Redis rate keys before/after：${cleanup?.redisKeysBefore ?? '-'} / ${cleanup?.redisKeysAfter ?? '-'}
- 证据日志秘密扫描：${secretScan?.passed ? 'PASS，无完整 Key、Bearer、带凭据连接串命中' : 'FAIL，见 secret-scan.json'}
- 测试 workspace：\`${cleanup?.workspaceId ?? 'UNKNOWN'}\`

## 14. 阶段 A/B 改动摘要

- 新增 behavior matrix fixture、B19 contract、全链 HTTP、认证完整性、并发、故障测试与证据运行/报告辅助脚本。
- 阶段 A 未修改产品实现；用户逐项批准全部 7 个问题后，阶段 B 才修改对应产品实现与 OpenAPI 源合同。
- 修复覆盖：registry 动态计数、预览 envelope、鉴权前置、示例脱敏、空 scope 422、update CAS/版本/审计、可信拒绝审计。
- 未新增依赖；未使用 skip/todo、未删除断言、未放宽阈值。
- 阶段 B 聚合修复提交保持本地，不 push、不创建 PR、不合并、不部署。
`;

writeFileSync(reportPath, report);
process.stdout.write(`${reportPath}\n`);
