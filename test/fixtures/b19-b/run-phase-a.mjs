#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const modeArg = process.argv.indexOf('--mode');
const mode = modeArg >= 0 ? process.argv[modeArg + 1] : 'targeted';
const runId =
  process.env.B19_B_RUN_ID?.trim() ||
  `b19-b-${new Date()
    .toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false })
    .replaceAll(':', '')
    .replaceAll(' ', '-')}`;
const shortCode = process.env.B19_B_SHORT_CODE?.trim() || runId.split('-').at(-1);
const evidenceDir = resolve(
  process.env.B19_B_EVIDENCE_DIR || join(root, 'test-results', 'b19-b', runId),
);
mkdirSync(evidenceDir, { recursive: true });

const nodeBin = dirname(process.execPath);
const childEnv = {
  ...process.env,
  PATH: `${nodeBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  B19_B_RUN_ID: runId,
  B19_B_SHORT_CODE: shortCode,
  B19_B_EVIDENCE_DIR: evidenceDir,
  KB_ENV: 'test',
  KB_LOG_LEVEL: process.env.KB_LOG_LEVEL || 'error',
  KB_TEST_MONGO_URI:
    process.env.KB_TEST_MONGO_URI ||
    `mongodb://127.0.0.1:27017/kb_test_b19b_${shortCode}?replicaSet=rs0&directConnection=true`,
  KB_TEST_REDIS_URL: process.env.KB_TEST_REDIS_URL || 'redis://127.0.0.1:6379/0',
  KB_TEST_PG_URL: process.env.KB_TEST_PG_URL || 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb',
  KB_TEST_S3_ENDPOINT: process.env.KB_TEST_S3_ENDPOINT || 'http://127.0.0.1:9000',
  KB_TEST_S3_REGION: process.env.KB_TEST_S3_REGION || 'us-east-1',
  KB_TEST_S3_BUCKET: process.env.KB_TEST_S3_BUCKET || `kb-test-${runId}`,
  KB_TEST_S3_ACCESS_KEY: process.env.KB_TEST_S3_ACCESS_KEY || 'minioadmin',
  KB_TEST_S3_SECRET_KEY: process.env.KB_TEST_S3_SECRET_KEY || 'minioadmin',
};

function capture(command) {
  const result = spawnSync('/bin/bash', ['-lc', command], {
    cwd: root,
    env: childEnv,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fileSha256(path) {
  return existsSync(path) ? sha256(readFileSync(path)) : null;
}

function sanitize(value) {
  return value
    .replace(/kn_live_[A-Za-z0-9_-]{24,}/g, '[REDACTED_API_KEY]')
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'\\]+/g, '[REDACTED_MONGO_URI]')
    .replace(/postgresql:\/\/[^\s"'\\]+/g, '[REDACTED_POSTGRES_URI]')
    .replace(/redis:\/\/[^\s"'\\]+/g, '[REDACTED_REDIS_URI]')
    .replace(/(Authorization:\s*Bearer\s+)[^\s"']+/gi, '$1[REDACTED]');
}

function stripAnsi(value) {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
}

function testCounts(text) {
  const clean = stripAnsi(text);
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

const targeted = [
  ['openapi-check', 'corepack pnpm openapi:check'],
  ['inventory', 'corepack pnpm knowledge:inventory'],
  ['runtime-check', 'corepack pnpm knowledge:check-runtime'],
  ['typecheck', 'corepack pnpm typecheck'],
  [
    'service-s10-status',
    'corepack pnpm --dir packages/service exec vitest run test/unit/s10-status.test.ts test/unit/s10-ops-worker.test.ts',
  ],
  [
    'service-s10-ops',
    'corepack pnpm --dir packages/service exec vitest run test/integration/s10-audit.test.ts test/integration/s10-ops.test.ts test/integration/knowledge-connector.test.ts',
  ],
  [
    'service-audit-matrix',
    'corepack pnpm --dir packages/service exec vitest run test/integration/kb-b19-b-audit-matrix.test.ts',
  ],
  [
    'service-status-scheduler',
    'corepack pnpm --dir packages/service exec vitest run test/integration/kb-b19-b-status-scheduler.test.ts',
  ],
  [
    'contract-s10',
    'corepack pnpm exec vitest run --config test/contract/vitest.config.ts test/contract/s10-ops-contract.test.ts test/contract/knowledge-connector.test.ts',
  ],
  [
    'tenant-s10',
    'corepack pnpm exec vitest run --config test/tenant/vitest.config.ts test/tenant/s10-ops-tenant.test.ts test/tenant/kb-b19-b-ops-tenant.test.ts',
  ],
  [
    'concurrency-b19-b',
    'corepack pnpm exec vitest run --config test/concurrency/vitest.config.ts test/concurrency/kb-b19-b-audit-status-concurrency.test.ts',
  ],
  [
    'security-s10',
    'corepack pnpm exec vitest run --config test/security/vitest.config.ts test/security/s10-audit-redaction.test.ts test/security/s10-status-security.test.ts test/security/kb-b19-b-audit-status-redaction.test.ts',
  ],
  [
    'fault-s10',
    'corepack pnpm exec vitest run --config test/fault/vitest.config.ts test/fault/s10-ops-fault.test.ts test/fault/s10-status-probe.test.ts test/fault/kb-b19-b-status-fault.test.ts',
  ],
  [
    'e2e-s10-ops-admin',
    'corepack pnpm exec vitest run --config test/e2e/vitest.config.ts test/e2e/s10-ops-admin.test.ts',
  ],
  [
    'e2e-b19-b-ui',
    'corepack pnpm exec vitest run --config test/e2e/vitest.config.ts test/e2e/kb-b19-b-ops-ui.test.ts',
  ],
];

const gates = [
  ['openapi-check', 'corepack pnpm openapi:check'],
  ['inventory', 'corepack pnpm knowledge:inventory'],
  ['runtime-check', 'corepack pnpm knowledge:check-runtime'],
  ['typecheck', 'corepack pnpm typecheck'],
  ['lint', 'corepack pnpm lint'],
  ['format-check', 'corepack pnpm format:check'],
  ['architecture-check', 'corepack pnpm architecture:check'],
  ['forbidden-files-check', 'corepack pnpm forbidden-files:check'],
  ['unit', 'corepack pnpm test:unit'],
  ['contract', 'corepack pnpm test:contract'],
  ['integration', 'corepack pnpm test:integration'],
  ['tenant', 'corepack pnpm test:tenant'],
  ['concurrency', 'corepack pnpm test:concurrency'],
  ['security', 'corepack pnpm test:security'],
  ['fault', 'corepack pnpm test:fault'],
  ['build', 'corepack pnpm build'],
  ['build-workers', 'corepack pnpm build:workers'],
  ['e2e', 'corepack pnpm test:e2e'],
];

const focused = [
  [
    'focused-audit-matrix',
    'corepack pnpm --dir packages/service exec vitest run test/integration/kb-b19-b-audit-matrix.test.ts',
  ],
  [
    'focused-status-scheduler',
    'corepack pnpm --dir packages/service exec vitest run test/integration/kb-b19-b-status-scheduler.test.ts',
  ],
  [
    'focused-security',
    'corepack pnpm exec vitest run --config test/security/vitest.config.ts test/security/kb-b19-b-audit-status-redaction.test.ts',
  ],
  [
    'focused-e2e-ui',
    'corepack pnpm exec vitest run --config test/e2e/vitest.config.ts test/e2e/kb-b19-b-ops-ui.test.ts',
  ],
  [
    'focused-contract-b18-boundary',
    'corepack pnpm exec vitest run --config test/contract/vitest.config.ts --reporter=verbose test/contract/kb-b18-b-consumer-boundary.test.ts',
  ],
];

const finalChecks = [
  ['final-openapi-check', 'corepack pnpm openapi:check'],
  ['final-inventory', 'corepack pnpm knowledge:inventory'],
  ['final-runtime-check', 'corepack pnpm knowledge:check-runtime'],
  ['final-typecheck', 'corepack pnpm typecheck'],
  ['final-lint', 'corepack pnpm lint'],
  ['final-format-check', 'corepack pnpm format:check'],
  ['final-architecture-check', 'corepack pnpm architecture:check'],
  ['final-forbidden-files-check', 'corepack pnpm forbidden-files:check'],
  ['final-integration', 'corepack pnpm test:integration'],
];

const commands =
  mode === 'gates'
    ? gates
    : mode === 'final'
      ? finalChecks
      : mode === 'focused'
        ? focused
        : mode === 'all'
          ? [...targeted, ...gates]
          : targeted;
const commandPath = join(evidenceDir, 'commands.json');
const existing = existsSync(commandPath) ? JSON.parse(readFileSync(commandPath, 'utf8')) : [];
const allRecords = [...existing];
const records = [];

const candidateSha = capture('git rev-parse HEAD');
const branch = capture('git branch --show-current');
const worktree = capture('git status --short --untracked-files=all');
const dockerPs = capture(
  `docker compose -p b19b${shortCode} -f deploy/docker-compose.yml ps --format json 2>/dev/null || true`,
);

const environment = {
  schemaVersion: 1,
  runId,
  mode,
  candidateSha,
  branch,
  worktreeClean: worktree.length === 0,
  capturedAt: new Date().toISOString(),
  timezone: 'Asia/Shanghai',
  locale: process.env.LANG || 'C.UTF-8',
  node: capture('node --version'),
  pnpm: capture('corepack pnpm --version'),
  docker: capture('docker --version'),
  compose: capture('docker compose version'),
  database: `kb_test_b19b_${shortCode}`,
  bucket: childEnv.KB_TEST_S3_BUCKET,
  services: dockerPs
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const item = JSON.parse(line);
        return [
          {
            service: item.Service,
            name: item.Name,
            state: item.State,
            health: item.Health,
            image: item.Image,
          },
        ];
      } catch {
        return [{ raw: line }];
      }
    }),
  hashes: {
    agents: fileSha256(join(root, 'AGENTS.md')),
    lockfile: fileSha256(join(root, 'pnpm-lock.yaml')),
    releaseImages: fileSha256(join(root, 'deploy/release-images.data.json')),
    executionManual: fileSha256('/mnt/d/Fastgpt/知识库第一层-67项业务能力验证执行手册.md'),
    frontendBehavior: fileSha256('/mnt/d/Fastgpt/FastGPT知识库前端用户交互行为规范(2).md'),
    systemDesign: fileSha256('/mnt/d/Fastgpt/KnowledgeBase-System-Design.md'),
    fastGptAppPackage: fileSha256('/mnt/d/Fastgpt/FastGPT/projects/app/package.json'),
    fastGptAuditSchema: fileSha256(
      '/mnt/d/Fastgpt/FastGPT/packages/service/support/user/audit/schema.ts',
    ),
    fastGptAuditUtil: fileSha256(
      '/mnt/d/Fastgpt/FastGPT/packages/service/support/user/audit/util.ts',
    ),
    fastGptModelTest: fileSha256(
      '/mnt/d/Fastgpt/FastGPT/projects/app/src/pages/api/core/ai/model/test.ts',
    ),
    fastGptModelProbe: fileSha256(
      '/mnt/d/Fastgpt/FastGPT/projects/app/src/pages/api/admin/system/model/status/probe.ts',
    ),
    b19bMatrix: fileSha256(join(root, 'test/fixtures/b19-b/ops-matrix.json')),
  },
};
writeFileSync(join(evidenceDir, 'environment.json'), `${JSON.stringify(environment, null, 2)}\n`);

for (const [name, command] of commands) {
  const startedAt = new Date();
  const started = process.hrtime.bigint();
  const result = spawnSync('/bin/bash', ['-lc', command], {
    cwd: root,
    env: childEnv,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const endedAt = new Date();
  const stdout = sanitize(result.stdout ?? '');
  const stderr = sanitize(result.stderr ?? '');
  writeFileSync(join(evidenceDir, `${name}.stdout.log`), stdout);
  writeFileSync(join(evidenceDir, `${name}.stderr.log`), stderr);
  const record = {
    name,
    command,
    cwd: root,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1_000_000),
    exitCode: result.status ?? 1,
    signal: result.signal ?? null,
    testCounts: testCounts(`${stdout}\n${stderr}`),
    stdoutPath: join(evidenceDir, `${name}.stdout.log`),
    stderrPath: join(evidenceDir, `${name}.stderr.log`),
  };
  records.push(record);
  allRecords.push(record);
  writeFileSync(commandPath, `${JSON.stringify(allRecords, null, 2)}\n`);
  process.stdout.write(
    `${record.exitCode === 0 ? 'PASS' : 'FAIL'} ${name} exit=${record.exitCode} duration=${record.durationMs}ms\n`,
  );
}

const patterns = {
  completeApiKey: /kn_live_[A-Za-z0-9_-]{24,}/g,
  bearerCredential: /Authorization:\s*Bearer\s+(?!\[REDACTED\])[^\s"']+/gi,
  mongoCredentialUri: /mongodb(?:\+srv)?:\/\/[^/\s]+:[^@\s]+@/g,
  postgresCredentialUri: /postgresql:\/\/[^/\s]+:[^@\s]+@/g,
  redisCredentialUri: /redis:\/\/[^/\s]+:[^@\s]+@/g,
};
const findings = [];
for (const name of readdirSync(evidenceDir).filter((name) => /\.(?:log|json)$/.test(name))) {
  const text = readFileSync(join(evidenceDir, name), 'utf8');
  for (const [kind, pattern] of Object.entries(patterns)) {
    if (pattern.test(text)) findings.push({ file: name, kind });
    pattern.lastIndex = 0;
  }
}
writeFileSync(
  join(evidenceDir, 'secret-scan.json'),
  `${JSON.stringify({ findings, passed: findings.length === 0 }, null, 2)}\n`,
);

const summary = {
  runId,
  candidateSha,
  startedFromMode: mode,
  completedCommands: records.length,
  failedCommands: records.filter((record) => record.exitCode !== 0).map((record) => record.name),
  secretScanPassed: findings.length === 0,
  evidenceDir,
};
writeFileSync(join(evidenceDir, 'run-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exitCode = records.some((record) => record.exitCode !== 0) ? 1 : 0;
