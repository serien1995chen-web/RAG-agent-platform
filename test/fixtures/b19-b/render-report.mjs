#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const runId = process.env.B19_B_RUN_ID?.trim();
const reportPath = process.env.B19_REPORT_PATH?.trim();
const patchPath = process.env.B19_PATCH_PATH?.trim();
const testCommitSha = process.env.B19_TEST_COMMIT_SHA?.trim();
if (!runId || !reportPath || !patchPath || !testCommitSha) {
  throw new Error(
    'B19_B_RUN_ID, B19_REPORT_PATH, B19_PATCH_PATH and B19_TEST_COMMIT_SHA are required',
  );
}

const evidenceDir = resolve(
  process.env.B19_B_EVIDENCE_DIR || join(root, 'test-results', 'b19-b', runId),
);
const commands = JSON.parse(readFileSync(join(evidenceDir, 'commands.json'), 'utf8'));
const environment = JSON.parse(readFileSync(join(evidenceDir, 'environment.json'), 'utf8'));
const resource = JSON.parse(
  readFileSync(join(evidenceDir, 'resource-reconciliation.json'), 'utf8'),
);
const redis = JSON.parse(readFileSync(join(evidenceDir, 'redis-key-inventory.json'), 'utf8'));
const cleanup = JSON.parse(readFileSync(join(evidenceDir, 'cleanup-stop.json'), 'utf8'));
const secretScan = JSON.parse(readFileSync(join(evidenceDir, 'secret-scan.json'), 'utf8'));

function run(command) {
  const result = spawnSync('/bin/bash', ['-lc', command], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function md(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function countsFromLog(path) {
  const clean = readFileSync(path, 'utf8').replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'),
    '',
  );
  const totals = { passed: 0, failed: 0, skipped: 0 };
  let found = false;
  for (const line of clean.split('\n').filter((value) => /\bTests\s+/.test(value))) {
    const passed = line.match(/(\d+)\s+passed/);
    const failed = line.match(/(\d+)\s+failed/);
    const skipped = line.match(/(\d+)\s+skipped/);
    if (!passed && !failed && !skipped) continue;
    found = true;
    totals.passed += Number(passed?.[1] ?? 0);
    totals.failed += Number(failed?.[1] ?? 0);
    totals.skipped += Number(skipped?.[1] ?? 0);
  }
  return found ? totals : { passed: null, failed: null, skipped: null };
}

for (const entry of commands) {
  entry.testCounts = countsFromLog(entry.stdoutPath);
}

const patchSha = sha256File(patchPath);
const head = run('git rev-parse HEAD');
const branch = run('git branch --show-current');
const originMain = run('git rev-parse origin/main');
const worktree = run('git status --short --untracked-files=all');
const patchFiles = run('git diff --name-only e810dde5832c6c85b4dc99e4e567b38c190395dd..HEAD')
  .split('\n')
  .filter(Boolean);
const testAssets = [
  ...patchFiles,
  ...readdirSync(join(root, 'test/fixtures/b19-b'))
    .filter((name) => /\.(?:ts|mjs|json)$/.test(name))
    .map((name) => `test/fixtures/b19-b/${name}`),
].filter((value, index, values) => values.indexOf(value) === index);

const docHashes = environment.hashes;
const assetAudit = [
  [
    'packages/service/test/integration/s10-audit.test.ts',
    'REUSE',
    'append-only、游标、safeDiff 基础证据',
  ],
  ['packages/service/test/integration/s10-ops.test.ts', 'REUSE', 'cleanup/reconcile/outbox CAS'],
  ['packages/service/test/unit/s10-status.test.ts', 'REUSE', 'fixture/external/unknown 不判 ok'],
  ['packages/service/test/unit/s10-ops-worker.test.ts', 'REUSE', 'worker fencing、重试和故障证据'],
  [
    'test/tenant/s10-ops-tenant.test.ts',
    'EXTEND',
    'A/B audit 隔离；新增 connector/status/model 切片',
  ],
  ['test/fault/s10-status-probe.test.ts', 'REUSE', '依赖/队列/connector probe 降级'],
  ['test/security/s10-audit-redaction.test.ts', 'EXTEND', '新增状态安全摘要和 provider 错误证据'],
  [
    'test/security/s10-status-security.test.ts',
    'STALE',
    '只验证注入 view，不证明真实 securityChecks',
  ],
  ['test/e2e/s10-ops-admin.test.ts', 'STALE', 'retired 页面整组 skip；保留 API 子测'],
  ['test/e2e/knowledge-connector.test.ts', 'EXTEND', '新增当前产品入口、失败/stale 和刷新恢复'],
];

const ops003 = [
  [
    'P01',
    'FAIL',
    'Space/Directory/Source/Tag 真实增删改后 audit 为 0；期望 9 个动作。',
    'kb-b19-b-audit-matrix',
  ],
  [
    'N01',
    'FAIL',
    '未知 action/resourceType 返回 200 空页；过期 TTL 记录仍可查询。',
    'kb-b19-b-audit-matrix',
  ],
  [
    'A01',
    'PASS',
    'A/B audit 隔离、非 admin/restricted Key 在 probe 前拒绝。',
    'kb-b19-b-ops-tenant',
  ],
  [
    'S01',
    'FAIL',
    'append-only guard 通过；TTL 到期不可查失败，故 S01 组合失败。',
    'kb-b19-b-audit-matrix',
  ],
  ['C01', 'PASS', '32 并发追加 eventId 唯一，分页无重无漏。', 'kb-b19-b-audit-status-concurrency'],
  [
    'F01',
    'PASS',
    'audit store 不可用 fail closed；Outbox replay/CAS 既有切片通过。',
    'kb-b19-b-audit-matrix; s10-ops',
  ],
  [
    'Q01',
    'PASS',
    'Token/Cookie/Prompt/正文/IP/UA/objectKey 脱敏和 evidence secret scan 通过。',
    'kb-b19-b-audit-matrix; secret-scan',
  ],
];

const ops005 = [
  [
    'P01',
    'FAIL',
    'connector API/readyz 可用，但无 scheduler model 或 runtime scheduler。',
    'kb-b19-b-status-scheduler',
  ],
  [
    'N01',
    'FAIL',
    '模型错误保持 UNKNOWN，但无安全分类 reason；overdue connector 无 stale。',
    'kb-b19-b-status-fault; status-scheduler',
  ],
  [
    'A01',
    'PASS',
    'connector 跨租户 404、非 admin/restricted status 403，不泄露存在性。',
    'kb-b19-b-ops-tenant',
  ],
  [
    'S01',
    'FAIL',
    'connector失败持久化及旧成功不覆盖新失败通过；scheduler 持久化缺失。',
    'kb-b19-b-status-fault; status-scheduler',
  ],
  [
    'C01',
    'PASS',
    '32 并发 status 查询无业务写；状态查询只读。',
    'kb-b19-b-audit-status-concurrency',
  ],
  [
    'F01',
    'PASS',
    '60s model probe timeout、依赖失败降级、provider 失败保持 failed。',
    'kb-b19-b-status-fault',
  ],
  [
    'Q01',
    'FAIL',
    'stale 字段、scheduler schema、安全摘要证据缺失；Redis/BullMQ 无 run prefix。',
    'status-scheduler; redis inventory',
  ],
  [
    'UI01',
    'FAIL',
    '入口存在；失败原因、时间和 stale 不可见；暂停状态同步按钮仍启用；模型失败无重试且保存启用。',
    'kb-b19-b-ops-ui',
  ],
];

const shared = [
  [
    'TEST-X-SECRET-LEAK',
    'PASS',
    'evidence secret scan 0 findings；响应未含测试凭据/连接串/private object key。',
  ],
  ['TEST-X-TENANT-GUARD', 'PASS', 'audit/connector/status 跨租户与管理 scope 切片通过。'],
  [
    'TEST-X-OUTBOX-CRASH',
    'PASS',
    '既有 s10-ops/s10-ops-worker replay CAS、重试和 dead-letter 切片通过。',
  ],
  [
    'TEST-X-COMPOSE-READY',
    'PASS',
    '真实 Mongo/Redis/PGVector/MinIO、Health、Ready、Worker ready marker 均通过。',
  ],
  [
    'TEST-X-SAAS-READY',
    'BLOCKED_PROVIDER',
    '托管依赖/Key/健康切片通过；无批准真实模型/第三方 Provider 凭证。',
  ],
  ['TEST-X-SCOPE-GUARD', 'PASS', '新增测试未注册网站、递归、语雀或钉钉运行时能力。'],
];

const behavior = [
  [
    'Audit append-only、重试与脱敏',
    'FastGPT MongoTeamAudit schema；addAuditLog 内部重试且写失败记录 logger；资源快照不含业务文档。',
    'schema.ts:17-75; util.ts:95-146',
    'MATCH；本项目更进一步要求业务事务/Outbox 与 fail-closed。',
  ],
  [
    '模型状态查询、手动全量 probe、自动探测配置',
    '管理员读取模型健康/48h 时间线；manual probe 强制全量；config 可启停、周期 5-60 分钟和 webhook。',
    'admin/system/model/status/index.ts:10-17; probe.ts:10-17; config.ts:13-26',
    'INTENTIONAL_DIFFERENCE；控制台布局独立，但状态/错误/刷新效果必须等价。',
  ],
  [
    '自动同步开关',
    '开关值来自服务端，切换需确认；保存失败时弹窗保持、开关不提前成功。',
    'Frontend KB-INFO-030/031，规范行 996-1008',
    'FAIL：开关可持久化，但失败/stale细节不完整。',
  ],
  [
    '同步中/等待/失败/unknown/stale',
    '处理中可查看阶段；异常可查看原因；轮询自动刷新；完成后转为 ready/failed。',
    'Frontend KB-COLLECTION-100/102/106，规范行 563-583；KB-INFO-062',
    'FAIL：失败原因、lastAttempt/lastSuccess 与 stale 不可观察。',
  ],
  [
    '模型配置失败',
    '模型不兼容/目录失败保留可恢复状态，刷新后不持久失败值。',
    'Frontend KB-INFO-026/027/062，规范行 983-995/1031-1038',
    'FAIL：错误仅在 Info 文本，不在配置弹窗；无 retry，保存仍启用。',
  ],
  [
    '严格安全合同',
    'FastGPT 审计写失败主要记录日志；本项目用户决策要求业务不得静默成功、secret redaction、append-only、tenant/ACL 更严格。',
    '用户权威顺序第 1 条；AGENTS 正确性/租户规则',
    'INTENTIONAL_DIFFERENCE；保留本项目更严格安全语义。',
  ],
];

const issues = [
  {
    id: 'B19-B-OPS-003-001',
    severity: 'P1',
    title: 'Space、Directory、Source、Tag 主业务动作未写审计',
    capability: 'OPS-003 / P01',
    expected:
      '每个 create/update/delete/apply 均写唯一 AuditEvent，包含 actor、request/trace、版本和安全 diff。',
    actual:
      '真实执行 Space/Directory/Source create+update 与 Tag create+update+delete，audit actions 为 `[]`。',
    repro:
      '`cd packages/service && pnpm exec vitest run test/integration/kb-b19-b-audit-matrix.test.ts`',
    evidence: '`audit-event-matrix.json`；`focused-audit-matrix.stdout.log`',
    root: '`catalog.repository.ts:260,398,992,1048,1186,1247` 与 `tag.repository.ts:126,181,203` 直接写业务集合，没有审批中的 audit append 调用链。',
    impact: '管理员无法追溯核心知识资产变更；权限响应虽可能审计，但基础资源变更缺失。',
    fix: '向 catalog/tag repository 注入 AuditPort，在对应 MongoDB transaction 内 append；Tag apply 同样写资源级安全摘要。',
    regression:
      '重跑 OPS-003 P01、B01/B02/B03/B04/B05 对应 integration、tenant、fault 和 AuditEvent 唯一索引。',
    deps: '无',
    api: '不新增公开字段；内部写路径和事务原子性变化。',
    ruling: 'INTENTIONAL_DIFFERENCE：本项目审计完整性严格于 FastGPT logger-only 写失败路径。',
  },
  {
    id: 'B19-B-OPS-003-002',
    severity: 'P2',
    title: '未知 audit action/resourceType 被接受为空结果',
    capability: 'OPS-003 / N01',
    expected: '未知枚举值返回稳定 KNOWLEDGE_VALIDATION_FAILED Problem。',
    actual: 'API-AUDIT-LIST 返回 200、items=[]。',
    repro: '运行 `kb-b19-b-audit-matrix.test.ts` 的两个 unknown-filter 用例。',
    evidence: '`focused-audit-matrix.stdout.log`',
    root: '`s10-operations.ts:311-359` 只校验 outcome/period，直接透传 action/resourceType；`s10-operations.repository.ts:167-171` 构造任意字符串 filter。',
    impact: '调用方无法区分“无事件”和拼写错误/非法过滤器。',
    fix: '在 operation boundary 用 AuditAction/ResourceType 枚举校验，未知值返回字段级 422。',
    regression: 'action/resourceType/outcome × valid/invalid；HTTP 与 application 各一层。',
    deps: '无',
    api: '错误语义更严格，成功响应不变。',
    ruling: 'MATCH 项目 OpenAPI/Problem 错误合同。',
  },
  {
    id: 'B19-B-OPS-003-003',
    severity: 'P2',
    title: 'TTL 已过期审计记录仍可查询',
    capability: 'OPS-003 / N01+S01',
    expected: 'expiresAt 已过期的记录不进入 audit list，即使 Mongo TTL monitor 尚未清理。',
    actual: '插入 expiresAt=now-1d 的事件后立即查询仍返回 1 条。',
    repro: '运行 `kb-b19-b-audit-matrix.test.ts` 的 expired TTL 用例。',
    evidence: '`focused-audit-matrix.stdout.log`；`audit-event-matrix.json`',
    root: '`s10-operations.repository.ts:163-191` TTL 查询仅按 workspace/action/period，没有 `expiresAt > now`。',
    impact: '过期审计存在最长约一个 TTL monitor 周期的可读窗口，破坏“到期后不可查”。',
    fix: '查询固定加入 `expiresAt: {$gt: now}`；TTL index 继续异步物理清理。',
    regression: '边界 now-1ms/now/now+1ms、分页 cursor、索引执行计划和 TTL index 断言。',
    deps: '无',
    api: '响应 schema 不变。',
    ruling: 'MATCH 用户 OPS-003 验收扩展。',
  },
  {
    id: 'B19-B-OPS-005-001',
    severity: 'P1',
    title: 'connector sync scheduler 和 scheduler record 未实现',
    capability: 'OPS-005 / P01+S01；Frontend KB-INFO-030/031',
    expected:
      '启用同步且 nextSyncAt 到期时幂等创建 sync Job；存在可观察 scheduler record；启动 reconcile 补齐缺失记录。',
    actual: '注册模型中没有 scheduler record，runtime/worker 源码均无 scheduler/cron 入口。',
    repro: '运行 `kb-b19-b-status-scheduler.test.ts`。',
    evidence: '`scheduler-contract.json`；`focused-status-scheduler.stdout.log`',
    root: '`knowledge-runtime.ts`/`knowledge-worker.ts` 只有 HTTP 与队列 worker；`knowledge-runtime-config.ts:12-55` 无 scheduler 配置。',
    impact: '自动同步不会由到期状态触发，OPS-005 核心业务不可用。',
    fix: '增加 scheduler 状态集合与 run-scoped lock，扫描 syncEnabled/status/nextSyncAt，复用 connector sync idempotency key；启动与周期 reconcile 缺失记录。',
    regression: '缺失/重复/并发到期、启停同步、worker crash、旧成功/新失败竞争、手动同步互斥。',
    deps: '现有 cron-parser/node-cron 已声明，无需新增依赖。',
    api: '需扩展 OpsStatus/Connector 状态 schema 或内部 scheduler DTO。',
    ruling: 'INTENTIONAL_DIFFERENCE：状态字段和调度记录按本项目设计。',
  },
  {
    id: 'B19-B-OPS-005-002',
    severity: 'P2',
    title: '连接器 overdue 状态没有 stale 判定',
    capability: 'OPS-005 / N01+Q01；Frontend KB-INFO-062',
    expected:
      'nextSyncAt 已过阈值且上次尝试过旧时，状态摘要标记 stale，并保留 nextSyncAt/lastSuccess/lastError。',
    actual:
      'connectorProbe 只返回 provider/status/verificationStatus/lastAttemptAt，无 stale/nextSyncAt。',
    repro: '运行 status-scheduler overdue 用例。',
    evidence: '`focused-status-scheduler.stdout.log`',
    root: '`s10-status-probes.adapter.ts:124-140` select 与 projection 缺 nextSyncAt；OpenAPI OpsStatus connectorProbes 也无 stale。',
    impact: '自动同步停止时仍可显示 active，不能区分配置正常与调度失效。',
    fix: '持久化/计算 stale 阈值，返回 nextSyncAt、lastAttemptAt、lastSuccessAt、lastError、stale；active 且 overdue 时整体 degraded。',
    regression: '阈值边界、paused/disabled/deleting 不误报、old-success/new-failure。',
    deps: '无',
    api: '扩展 OpsStatus.connectorProbes 和 production OpenAPI。',
    ruling: 'MATCH 前端失败/stale 可观察要求。',
  },
  {
    id: 'B19-B-OPS-005-003',
    severity: 'P1',
    title: 'securityChecks 将 scope/audit/redaction 硬编码为 true',
    capability: 'OPS-005 / Q01',
    expected: '每项安全摘要来自真实探测或可验证能力状态。',
    actual: '`scopeEnforced`、`auditAppendOnly`、`secretRedactionEnabled` 无条件 true。',
    repro: '运行 `kb-b19-b-audit-status-redaction.test.ts` 的 hard-code 断言。',
    evidence: '`focused-security.stdout.log`',
    root: '`s10-status-probes.adapter.ts:245-250` 直接字面量赋值。',
    impact: '状态页可能展示虚假安全健康，误导运维和验收。',
    fix: '由 auth/audit/redaction probes 注入布尔证据；探测失败返回 false+UNKNOWN reason，禁止常量。',
    regression: '正常/失败/权限拒绝/审计 store 不可用四态。',
    deps: '无',
    api: '字段形状可不变，语义从常量改为 evidence-backed。',
    ruling: 'MATCH 用户明确要求 securityChecks 与真实状态一致。',
  },
  {
    id: 'B19-B-OPS-005-004',
    severity: 'P2',
    title: '模型 probe 401/403/404/429/5xx/invalid/timeout 未保留安全原因',
    capability: 'OPS-005 / N01+Q01',
    expected: '失败返回 failed/unknown 且带有稳定、脱敏的错误分类供 UI/运维区分。',
    actual:
      'catch 吞掉所有错误，只返回 status=unavailable、verificationStatus=UNKNOWN，无 reason。',
    repro: '运行 security 测试 7 个 provider failure 参数化用例。',
    evidence: '`focused-security.stdout.log`',
    root: '`s10-status-probes.adapter.ts:83-121` catch 丢弃错误；modelProbe schema 无 reason。',
    impact: '用户只能看到 unknown，无法知道配置、鉴权、限流或超时。',
    fix: '分类错误为 safe reason/code，不保留 provider 原文或 secret；扩展 OpsStatus.modelProbe.reason。',
    regression: '401/403/404/429/5xx/schema/timeout 全矩阵和脱敏。',
    deps: '无',
    api: '扩展 modelProbe reason/errorCode。',
    ruling: 'INTENTIONAL_DIFFERENCE：本项目状态合同更严格。',
  },
  {
    id: 'B19-B-OPS-005-005',
    severity: 'P2',
    title: 'Redis/BullMQ key 没有 run-scoped prefix',
    capability: 'OPS-005 / Q01',
    expected: 'Redis key、BullMQ queue key/job namespace 带 b19-b-runId，避免共享实例污染。',
    actual: '运行结束时 724 keys，只有 17 个含 runId，215 个使用全局 `bull:knowledge-*`。',
    repro: '`capture-redis.ts`；status scheduler prefix 断言。',
    evidence: '`redis-key-inventory.json`；`focused-status-scheduler.stdout.log`',
    root: '`knowledge-runtime-config.ts:12-55` 无 queue prefix；`knowledge-runtime.ts:1392` 与 worker 的 BullMQ adapter 使用默认 `bull`。',
    impact: '共享 Redis 时会与其他运行串队列、统计和重试。',
    fix: '增加 KB_REDIS_PREFIX/queuePrefix 配置，runtime/worker/BullMqQueueAdapter 统一使用。',
    regression: '双运行同 Redis 隔离、ready、status queue counts、cleanup 和 restart。',
    deps: '无',
    api: '环境配置新增，业务 API 不变。',
    ruling: 'MATCH 用户隔离命名空间硬约束。',
  },
  {
    id: 'B19-B-OPS-005-006',
    severity: 'P2',
    title: '连接器失败原因、时间和 stale 在 UI 不可观察',
    capability: 'OPS-005 / UI01；Frontend KB-COLLECTION-100/102/106、KB-INFO-062',
    expected:
      '详情显示 failed、safe lastError、lastAttemptAt、lastSuccessAt、nextSyncAt 和 stale。',
    actual:
      'UI 显示“失败”与 nextSyncAt，但不显示 lastError、lastAttemptAt、lastSuccessAt 或 stale。',
    repro: '运行 `kb-b19-b-ops-ui.test.ts` 的 failed/stale 两个用例。',
    evidence: '`ui/connector-failed-stale-1440x900.png`；`focused-e2e-ui.stdout.log`',
    root: '`connectors-panel.tsx:159-185` 只渲染 status/version/nextSyncAt；数据源 Info 仅状态和 lastSuccessAt。',
    impact: '用户无法判断失败原因或调度是否停摆。',
    fix: '渲染安全 lastError.message/code、三个时间字段和 stale badge；使用 aria-live 更新。',
    regression: '1440×900 zh-CN、刷新、syncing/failed/unknown/stale、axe、console。',
    deps: '无',
    api: '依赖 OPS-005-002 状态字段。',
    ruling: 'MATCH Frontend KB-COLLECTION-100/102/106、KB-INFO-062。',
  },
  {
    id: 'B19-B-OPS-005-007',
    severity: 'P2',
    title: '暂停自动同步后“提交同步”仍可用',
    capability: 'OPS-005 / UI01；Frontend KB-INFO-030/031',
    expected: 'syncEnabled=false/paused 时手动同步禁用并解释原因。',
    actual: '刷新后开关为关闭、服务端 paused，但提交同步按钮仍 enabled。',
    repro: '运行 auto-sync persistence UI 用例。',
    evidence: '`focused-e2e-ui.stdout.log`；`ui-auto-sync-persistence.json` 未到达生成点',
    root: '`connectors-panel.tsx:178-181` Button 仅绑定 busy，没有 disabled 条件。',
    impact: '用户可发起服务端必拒绝的冲突操作，反馈滞后。',
    fix: 'disabled = busy || !syncEnabled || status in paused/failed/syncing/deleting，并提供可访问原因。',
    regression: 'active/paused/failed/syncing/deleting 与键盘焦点。',
    deps: '无',
    api: 'UI 行为修复，无接口变化。',
    ruling: 'MATCH 前端失败/禁用状态要求。',
  },
  {
    id: 'B19-B-OPS-005-008',
    severity: 'P2',
    title: '模型目录失败未在配置弹窗显示、无 retry 且保存未禁用',
    capability: 'OPS-005 / UI01；Frontend KB-INFO-026/027/062',
    expected: '模型目录失败给出可重试错误，阻止保存并保留原配置。',
    actual: 'Info 显示“模型目录暂不可用”，但配置弹窗无错误/retry，保存按钮启用。',
    repro: '运行 model catalog failure UI 用例。',
    evidence: '`ui/model-catalog-failure-1440x900.png`；`focused-e2e-ui.stdout.log`',
    root: '`dataset-detail-page.tsx:2093-2112` 不消费 modelsQuery.error；`:2188-2198` 保存始终 enabled。',
    impact: '用户可打开空配置并提交空/不完整模型绑定，失败原因不可恢复。',
    fix: '把 modelsQuery.error 传入 ProductError/ProblemNotice，提供 retry；无模型目录时禁用保存并保留服务端值。',
    regression: '目录 503/timeout/empty、重试成功、刷新恢复、focus/axe。',
    deps: '无',
    api: '无生产合同变化。',
    ruling: 'MATCH Frontend KB-INFO-026/027/062。',
  },
];

const commandRows = commands.map(
  (entry) =>
    `| ${md(entry.name)} | ${entry.exitCode} | ${entry.testCounts.passed ?? '-'} | ${entry.testCounts.failed ?? '-'} | ${entry.testCounts.skipped ?? '-'} | ${md(entry.command)} |`,
);

const behaviorRows = behavior.map(
  ([dimension, expected, source, result]) =>
    `| ${md(dimension)} | ${md(expected)} | ${md(source)} | ${md(result)} |`,
);
const assetRows = assetAudit.map(
  ([path, decision, note]) => `| ${md(path)} | ${decision} | ${md(note)} |`,
);
const ops003Rows = ops003.map(
  ([id, status, result, tests]) => `| ${id} | ${status} | ${md(result)} | ${md(tests)} |`,
);
const ops005Rows = ops005.map(
  ([id, status, result, tests]) => `| ${id} | ${status} | ${md(result)} | ${md(tests)} |`,
);
const sharedRows = shared.map(([id, status, result]) => `| ${id} | ${status} | ${md(result)} |`);
const assetList = testAssets.map((path) => `- \`${path}\``).join('\n');
const issueSections = issues
  .map(
    (issue, index) => `### ${index + 1}. ${issue.id} — ${issue.title}

| 字段 | 内容 |
| --- | --- |
| Capability / 子测 | ${md(issue.capability)} |
| 严重度 | ${issue.severity} |
| 状态 | PENDING_APPROVAL |
| FastGPT 预期 / 前端 ID | ${md(issue.expected)} |
| 项目验收扩展 | 用户 B19/OPS 矩阵及当前 OpenAPI/Problem/tenant/security 合同 |
| 实际结果 | ${md(issue.actual)} |
| 最小复现 | ${md(issue.repro)} |
| 失败证据 | ${md(issue.evidence)} |
| 根因文件和调用链 | ${md(issue.root)} |
| 影响 | ${md(issue.impact)} |
| 建议最小修复 | ${md(issue.fix)} |
| 建议回归 | ${md(issue.regression)} |
| 新依赖 | ${md(issue.deps)} |
| API/Schema/CI 影响 | ${md(issue.api)} |
| 行为裁定 | ${md(issue.ruling)} |
| 审批 | PENDING |
`,
  )
  .join('\n');

const gateFailures = commands.filter((entry) => entry.exitCode !== 0);
const finalIntegration = commands.filter((entry) => entry.name === 'final-integration').at(-1);
const finalE2E = commands.filter((entry) => entry.name === 'e2e').at(-1);
const finalUnit = commands.filter((entry) => entry.name === 'unit').at(-1);
const conclusion =
  '**FAIL。** OPS-003 核心事件缺失、审计过滤/TTL 错误；OPS-005 scheduler/stale/security evidence/模型错误反馈和 UI01 不满足合同。App/Worker readiness 与大量安全、tenant、concurrency、fault 切片通过。真实 Provider 健康为 `BLOCKED_PROVIDER`，不是 PASS。';

const body = `# B19-B OPS-003 / OPS-005 阶段 A 验证报告

> 运行 ID：\`${runId}\`<br>
> 时区：Asia/Shanghai<br>
> 结论：${conclusion}

## 1. 基线与工作树

| 项目 | 值 |
| --- | --- |
| 冻结基线 / origin/main | \`e810dde5832c6c85b4dc99e4e567b38c190395dd\` / \`${originMain}\` |
| B 测试提交 | \`${testCommitSha}\` |
| 当前 HEAD / 分支 | \`${head}\` / \`${branch}\` |
| 工作树 | ${worktree ? md(worktree) : 'clean'} |
| App / Worker | 真实本地进程启动，Health/Ready 和 Worker ready marker 通过 |
| FastGPT | 4.17.4，本地文件树；无 Git 元数据 |

## 2. SHA-256 快照

| 输入/产物 | SHA-256 |
| --- | --- |
| AGENTS.md | \`${docHashes.agents}\` |
| pnpm-lock.yaml | \`${docHashes.lockfile}\` |
| release-images.data.json | \`${docHashes.releaseImages}\` |
| 执行手册 | \`${docHashes.executionManual}\` |
| 前端行为规范 (2) | \`${docHashes.frontendBehavior}\` |
| 系统设计 | \`${docHashes.systemDesign}\` |
| FastGPT app package.json | \`${docHashes.fastGptAppPackage}\` |
| FastGPT audit schema.ts | \`${docHashes.fastGptAuditSchema}\` |
| FastGPT audit util.ts | \`${docHashes.fastGptAuditUtil}\` |
| FastGPT model test.ts | \`${docHashes.fastGptModelTest}\` |
| FastGPT model probe.ts | \`${docHashes.fastGptModelProbe}\` |
| B19-B matrix fixture | \`${docHashes.b19bMatrix}\` |
| Patch | \`${patchSha}\` |

## 3. FastGPT 行为矩阵

| 维度 | FastGPT 可观察行为 | 源码/规范定位 | 本项目裁定 |
| --- | --- | --- | --- |
${behaviorRows.join('\n')}

## 4. 测试资产审计

| 资产 | 决策 | 原因 |
| --- | --- | --- |
${assetRows.join('\n')}

## 5. OPS-003 矩阵

| 子测 | 状态 | 结果 | 测试 |
| --- | --- | --- | --- |
${ops003Rows.join('\n')}

## 6. OPS-005 矩阵

| 子测 | 状态 | 结果 | 测试 |
| --- | --- | --- | --- |
${ops005Rows.join('\n')}

## 7. 共享横切

| 测试 | 状态 | 结果 |
| --- | --- | --- |
${sharedRows.join('\n')}

## 8. 命令与证据

- 证据目录：\`test-results/b19-b/${runId}/\`
- 命令记录：\`commands.json\`
- 环境：\`environment.json\`
- Secret scan：${secretScan.passed ? 'PASS（0 findings）' : 'FAIL'}
- Unit：${finalUnit ? `${finalUnit.testCounts.passed ?? '-'} passed / ${finalUnit.testCounts.failed ?? '-'} failed` : '见 commands.json'}
- Final integration：${finalIntegration ? `${finalIntegration.testCounts.passed ?? '-'} passed / ${finalIntegration.testCounts.failed ?? '-'} failed` : '见 commands.json'}
- Full E2E：${finalE2E ? `${finalE2E.testCounts.passed ?? '-'} passed / ${finalE2E.testCounts.failed ?? '-'} failed / ${finalE2E.testCounts.skipped ?? '-'} skipped` : '见 commands.json'}
- 失败命令总数：${gateFailures.length}

| 命令记录 | Exit | Passed | Failed | Skipped | 实际命令 |
| --- | ---: | ---: | ---: | ---: | --- |
${commandRows.join('\n')}

完整 contract 门禁另有 1 个 STALE baseline 断言失败：\`test/contract/kb-b18-b-consumer-boundary.test.ts:53\` 期望 FastGPT 4.17.3/app package hash \`125a937...\`，当前冻结输入为 4.17.4/\`3887440d...\`。该历史 B18 test 未在 CodexB 范围内修改，按 STALE 记录，不计作 OPS 产品通过。

## 9. PENDING_APPROVAL 问题

${issueSections}

## 10. Provider 与环境阻断

- \`BLOCKED_PROVIDER\`：无批准真实模型 Endpoint/模型 ID、飞书真实 app/folder token。fixture/external/unknown 和失败分类已验证，未伪造 ready。
- App/Worker、Mongo 副本集、Redis、PostgreSQL/pgvector、MinIO、真实 HTTP、健康检查均可用。
- 未执行 stage B、未修产品代码、未 push/PR/merge/deploy。

## 11. 清理与对账

- 清理时间：${cleanup.stoppedAt}
- 隔离 Compose project：\`${cleanup.composeProject}\`
- 清理后容器/卷/网络：0 / 0 / 0
- Mongo run-prefix 孤儿文档：${resource.orphanDocumentCount}
- MinIO run bucket 用户对象：${cleanup.minioBucketUserFilesBeforeStop}
- Redis 停止前 DB size：${redis.databaseSize}
- 含 runId 的 Redis key：${redis.runPrefixedKeyCount}
- 全局 BullMQ key：${redis.globalQueueKeyCount}
- 保留 \`test-results/b19-b/${runId}/\` 作为证据，未执行 git clean。

## 12. 测试资产列表

${assetList}

## 13. Patch

- 基线：\`e810dde5832c6c85b4dc99e4e567b38c190395dd\`
- 测试提交：\`${testCommitSha}\`
- 命令：\`git diff --binary e810dde5832c6c85b4dc99e4e567b38c190395dd..HEAD > "${patchPath}"\`
- 文件范围：仅 \`packages/*/test/**\`、\`test/**\`、\`test/fixtures/b19-b/**\`
- Patch SHA-256：\`${patchSha}\`
- Patch 文件名：\`${basename(patchPath)}\`
- Patch 已在仓库外临时 detached worktree 执行 \`git apply --check\`。

## 14. 交接

**等待用户把报告和 patch 交给 CodexA。** CodexA 应审批缺陷、实施最小修复并从受影响 P/N/A/S/C/F/Q/UI 与共享切片开始重测；阶段 B 不在本次完成范围。
`;

const reportSha = sha256Text(body);
const content = `${body}

## 报告文件校验

- 报告内容 SHA-256（以上正文到此节之前，不含本节）：\`${reportSha}\`
- 报告文件名：\`${basename(reportPath)}\`

**等待用户把报告和 patch 交给 CodexA。**
`;
writeFileSync(reportPath, content);
process.stdout.write(
  `${JSON.stringify({ reportPath, reportSha256: reportSha, patchPath, patchSha256: patchSha }, null, 2)}\n`,
);
