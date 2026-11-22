#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const mode = process.argv.includes('--mode')
  ? process.argv[process.argv.indexOf('--mode') + 1]
  : 'target';
const now = new Date();
const timestamp = now
  .toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false })
  .replaceAll(':', '')
  .replaceAll(' ', '-');
const runId = process.env.B19_RUN_ID?.trim() || `b19-${timestamp}`;
const evidenceDir = resolve(
  process.env.B19_EVIDENCE_DIR?.trim() || join(root, 'test-results', 'b19-apikey', runId),
);
mkdirSync(evidenceDir, { recursive: true });

const childEnv = {
  ...process.env,
  PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
  KB_ENV: 'test',
  KB_TEST_MONGO_URI:
    process.env.KB_TEST_MONGO_URI ?? 'mongodb://127.0.0.1:27017/kb_test?replicaSet=rs0',
  KB_TEST_REDIS_URL: process.env.KB_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/0',
  KB_TEST_PG_URL: process.env.KB_TEST_PG_URL ?? 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb',
  KB_TEST_S3_ENDPOINT: process.env.KB_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
  KB_TEST_S3_REGION: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
  KB_TEST_S3_BUCKET: process.env.KB_TEST_S3_BUCKET ?? 'kb-test',
  KB_TEST_S3_ACCESS_KEY: process.env.KB_TEST_S3_ACCESS_KEY ?? 'minioadmin',
  KB_TEST_S3_SECRET_KEY: process.env.KB_TEST_S3_SECRET_KEY ?? 'minioadmin',
  B19_EVIDENCE_DIR: evidenceDir,
};

function capture(command) {
  const result = spawnSync('/bin/bash', ['-lc', command], {
    cwd: root,
    env: childEnv,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return (result.stdout ?? '').trim();
}

function sha256(relativePath) {
  const absolutePath = relativePath.startsWith('/') ? relativePath : join(root, relativePath);
  return existsSync(absolutePath)
    ? createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
    : null;
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
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  return value.replace(ansiPattern, '');
}

function testCounts(text) {
  const clean = stripAnsi(text);
  const testsLine = clean
    .split('\n')
    .reverse()
    .find((line) => /^\s*Tests\s+/.test(line));
  if (!testsLine) return { passed: null, failed: null, skipped: null };
  const failed = Number(testsLine.match(/(\d+)\s+failed/)?.[1] ?? 0);
  const passed = Number(testsLine.match(/(\d+)\s+passed/)?.[1] ?? 0);
  const skipped = Number(testsLine.match(/(\d+)\s+skipped/)?.[1] ?? 0);
  return { passed, failed, skipped };
}

const targeted = [
  ['openapi-check', 'pnpm openapi:check'],
  ['inventory', 'pnpm knowledge:inventory'],
  ['runtime-check', 'pnpm knowledge:check-runtime'],
  ['typecheck', 'pnpm typecheck'],
  [
    'service-unit-api-key',
    'cd packages/service && pnpm exec vitest run test/unit/s10-api-key.test.ts',
  ],
  [
    'service-integration-api-key-audit',
    'cd packages/service && pnpm exec vitest run test/integration/s10-api-key.test.ts test/integration/s10-audit.test.ts',
  ],
  [
    'contract-existing',
    'pnpm exec vitest run --config test/contract/vitest.config.ts test/contract/knowledge-contract.test.ts test/contract/s10-ops-contract.test.ts',
  ],
  [
    'contract-b19',
    'pnpm exec vitest run --config test/contract/vitest.config.ts test/contract/kb-b19-api-key-contract.test.ts',
  ],
  [
    'e2e-existing-key',
    'pnpm exec vitest run --config test/e2e/vitest.config.ts test/e2e/s10-ops-admin.test.ts test/e2e/s10-downstream-real-key.test.ts',
  ],
  [
    'e2e-b19-key',
    'pnpm exec vitest run --config test/e2e/vitest.config.ts test/e2e/kb-b19-api-key-http.test.ts',
  ],
  [
    'security-existing',
    'pnpm exec vitest run --config test/security/vitest.config.ts test/security/s10-api-key-auth.test.ts test/security/s10-audit-redaction.test.ts test/security/s10-secret-leak.test.ts test/security/s11-api-key-tenant.test.ts',
  ],
  [
    'security-b19',
    'pnpm exec vitest run --config test/security/vitest.config.ts test/security/kb-b19-api-key-auth-integrity.test.ts',
  ],
  [
    'tenant-key',
    'pnpm exec vitest run --config test/tenant/vitest.config.ts test/tenant/s10-api-key-tenant.test.ts',
  ],
  [
    'concurrency-key',
    'pnpm exec vitest run --config test/concurrency/vitest.config.ts test/concurrency/s10-api-key-concurrency.test.ts test/concurrency/kb-b19-api-key-races.test.ts',
  ],
  [
    'fault-key',
    'pnpm exec vitest run --config test/fault/vitest.config.ts test/fault/kb-b19-api-key-fault.test.ts',
  ],
];

const gates = [
  ['openapi-check', 'pnpm openapi:check'],
  ['inventory', 'pnpm knowledge:inventory'],
  ['runtime-check', 'pnpm knowledge:check-runtime'],
  ['typecheck', 'pnpm typecheck'],
  ['lint', 'pnpm lint'],
  ['format-check', 'pnpm format:check'],
  ['architecture-check', 'pnpm architecture:check'],
  ['forbidden-files-check', 'pnpm forbidden-files:check'],
  ['unit', 'pnpm test:unit'],
  ['contract', 'pnpm test:contract'],
  ['integration', 'pnpm test:integration'],
  ['tenant', 'pnpm test:tenant'],
  ['concurrency', 'pnpm test:concurrency'],
  ['security', 'pnpm test:security'],
  ['fault', 'pnpm test:fault'],
  ['build', 'pnpm build'],
  ['build-workers', 'pnpm build:workers'],
  ['e2e', 'pnpm test:e2e'],
];

const reruns = [
  [
    'e2e-s7-isolated',
    'pnpm exec vitest run --config test/e2e/vitest.config.ts test/e2e/s7-search-page.test.ts',
  ],
  ['e2e-final', 'pnpm test:e2e'],
];

const commands =
  mode === 'gates'
    ? gates
    : mode === 'all'
      ? [...targeted, ...gates]
      : mode === 'rerun'
        ? reruns
        : targeted;

const existingPath = join(evidenceDir, 'commands.json');
const existing = existsSync(existingPath) ? JSON.parse(readFileSync(existingPath, 'utf8')) : [];
const allRecords = [...existing];
const records = [];
const candidateSha = capture('git rev-parse HEAD');
childEnv.B19_CANDIDATE_SHA = candidateSha;

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
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const stdout = sanitize(result.stdout ?? '');
  const stderr = sanitize(result.stderr ?? '');
  const combined = `${stdout}\n${stderr}`;
  const stdoutPath = join(evidenceDir, `${name}.stdout.log`);
  const stderrPath = join(evidenceDir, `${name}.stderr.log`);
  writeFileSync(stdoutPath, stdout);
  writeFileSync(stderrPath, stderr);
  const counts = testCounts(combined);
  const record = {
    name,
    command,
    cwd: root,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: Math.round(durationMs),
    exitCode: result.status ?? 1,
    signal: result.signal ?? null,
    testCounts: counts,
    stdoutPath,
    stderrPath,
  };
  records.push(record);
  allRecords.push(record);
  writeFileSync(existingPath, `${JSON.stringify(allRecords, null, 2)}\n`);
  process.stdout.write(
    `${record.exitCode === 0 ? 'PASS' : 'FAIL'} ${name} exit=${record.exitCode} duration=${record.durationMs}ms\n`,
  );
}

const docker = capture(
  'docker compose -f deploy/docker-compose.yml ps --format json 2>/dev/null || true',
);
const environment = {
  runId,
  mode,
  candidateSha,
  currentBranch: capture('git branch --show-current'),
  worktreeStatus: capture('git status --short --untracked-files=all'),
  capturedAt: now.toISOString(),
  timezone: 'Asia/Shanghai',
  node: capture('node --version'),
  pnpm: capture('pnpm --version'),
  time: capture('date "+%Y-%m-%d %H:%M:%S %Z %z"'),
  hashes: {
    agents: sha256('AGENTS.md'),
    lockfile: sha256('pnpm-lock.yaml'),
    releaseImages: sha256('deploy/release-images.data.json'),
    executionManual: sha256('/mnt/d/Fastgpt/知识库第一层-67项业务能力验证执行手册.md'),
    frontendBehavior: sha256('/mnt/d/Fastgpt/FastGPT知识库前端用户交互行为规范.md'),
    systemDesign: sha256('/mnt/d/Fastgpt/KnowledgeBase-System-Design.md'),
    behaviorMatrix: sha256('test/fixtures/b19/api-key-behavior-matrix.json'),
    fixtureManifest: sha256('test/fixtures/s11/fixture-manifest.json'),
    fastGptAuth: sha256('/mnt/d/Fastgpt/FastGPT/packages/service/support/openapi/auth.ts'),
    fastGptCreate: sha256(
      '/mnt/d/Fastgpt/FastGPT/projects/app/src/pages/api/support/openapi/create.ts',
    ),
    fastGptList: sha256(
      '/mnt/d/Fastgpt/FastGPT/projects/app/src/pages/api/support/openapi/list.ts',
    ),
  },
  services: docker
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        const item = JSON.parse(line);
        return {
          service: item.Service,
          name: item.Name,
          state: item.State,
          health: item.Health,
          image: item.Image,
        };
      } catch {
        return { raw: line };
      }
    }),
};
writeFileSync(join(evidenceDir, 'environment.json'), `${JSON.stringify(environment, null, 2)}\n`);

const secretPatterns = {
  completeApiKey: /kn_live_[A-Za-z0-9_-]{24,}/g,
  bearerCredential: /Authorization:\s*Bearer\s+(?!\[REDACTED\])[^\s"']+/gi,
  mongoCredentialUri: /mongodb(?:\+srv)?:\/\/[^/\s]+:[^@\s]+@/g,
  postgresCredentialUri: /postgresql:\/\/[^/\s]+:[^@\s]+@/g,
  redisCredentialUri: /redis:\/\/[^/\s]+:[^@\s]+@/g,
};
const scanFindings = [];
for (const name of readdirSync(evidenceDir).filter((file) => file.endsWith('.log'))) {
  const content = readFileSync(join(evidenceDir, name), 'utf8');
  for (const [kind, pattern] of Object.entries(secretPatterns)) {
    if (pattern.test(content)) scanFindings.push({ file: name, kind });
    pattern.lastIndex = 0;
  }
}
writeFileSync(
  join(evidenceDir, 'secret-scan.json'),
  `${JSON.stringify({ findings: scanFindings, passed: scanFindings.length === 0 }, null, 2)}\n`,
);
process.stdout.write(`B19_RUN_ID=${runId}\nB19_EVIDENCE_DIR=${evidenceDir}\n`);
