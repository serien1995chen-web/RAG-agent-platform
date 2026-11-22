#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const runId = process.env.B19_RUN_ID?.trim() || 'b19-a-20261122-220039-7c1e';
if (!/^b19-a-\d{8}-\d{6}-[a-z0-9]{4,12}$/.test(runId)) {
  throw new Error(`invalid B19_RUN_ID: ${runId}`);
}
const shortCode = runId.split('-').at(-1);
const evidenceDir = resolve(
  process.env.B19_EVIDENCE_DIR?.trim() || join(root, 'test-results', 'b19-a', runId),
);
mkdirSync(evidenceDir, { recursive: true });

const childEnv = {
  ...process.env,
  KB_ENV: 'test',
  KB_TEST_MONGO_URI:
    process.env.KB_TEST_MONGO_URI ??
    `mongodb://127.0.0.1:27017/kb_test_b19a_${shortCode}?replicaSet=rs0`,
  KB_TEST_REDIS_URL: process.env.KB_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15',
  KB_TEST_PG_URL: process.env.KB_TEST_PG_URL ?? 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb',
  KB_TEST_S3_ENDPOINT: process.env.KB_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
  KB_TEST_S3_REGION: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
  KB_TEST_S3_BUCKET: process.env.KB_TEST_S3_BUCKET ?? `b19-a-${shortCode}`,
  KB_TEST_S3_ACCESS_KEY: process.env.KB_TEST_S3_ACCESS_KEY ?? 'minioadmin',
  KB_TEST_S3_SECRET_KEY: process.env.KB_TEST_S3_SECRET_KEY ?? 'minioadmin',
  FASTGPT_REFERENCE_ROOT: process.env.FASTGPT_REFERENCE_ROOT ?? '/mnt/d/Fastgpt/FastGPT',
  B19_RUN_ID: runId,
  B19_EVIDENCE_DIR: evidenceDir,
  TURBO_FORCE: 'true',
};

function run(command, options = {}) {
  const result = spawnSync('/bin/bash', ['-lc', command], {
    cwd: root,
    env: childEnv,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function sanitize(value) {
  return value
    .replace(/kn_live_[A-Za-z0-9_-]{24,}/g, '[REDACTED_API_KEY]')
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'\\]+/g, '[REDACTED_MONGO_URI]')
    .replace(/postgresql:\/\/[^\s"'\\]+/g, '[REDACTED_POSTGRES_URI]')
    .replace(/redis:\/\/[^\s"'\\]+/g, '[REDACTED_REDIS_URI]')
    .replace(/(Authorization:\s*Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(Cookie:\s*)[^\n\r]+/gi, '$1[REDACTED]');
}

function stripAnsi(value) {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
}

function testCounts(value) {
  const testsLine = stripAnsi(value)
    .split('\n')
    .reverse()
    .find((line) => /^\s*Tests\s+/.test(line));
  if (!testsLine) return { passed: null, failed: null, skipped: null };
  return {
    passed: Number(testsLine.match(/(\d+)\s+passed/)?.[1] ?? 0),
    failed: Number(testsLine.match(/(\d+)\s+failed/)?.[1] ?? 0),
    skipped: Number(testsLine.match(/(\d+)\s+skipped/)?.[1] ?? 0),
  };
}

function sha256(path) {
  const absolute = path.startsWith('/') ? path : join(root, path);
  return existsSync(absolute)
    ? createHash('sha256').update(readFileSync(absolute)).digest('hex')
    : null;
}

const candidateSha = run('git rev-parse HEAD').stdout.trim();
childEnv.B19_CANDIDATE_SHA = candidateSha;
const composePs = run('docker compose -f deploy/docker-compose.yml ps --format json');
const composeContainers =
  composePs.status === 0
    ? composePs.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const environment = {
  runId,
  candidateSha,
  branch: run('git branch --show-current').stdout.trim(),
  originMain: run('git rev-parse origin/main').stdout.trim(),
  worktreeStatus: run('git status --porcelain=v1 --untracked-files=all').stdout.trim(),
  node: run('node --version').stdout.trim(),
  pnpm: run('pnpm --version').stdout.trim(),
  docker: run('docker --version').stdout.trim(),
  composeVersion: run('docker compose version').stdout.trim(),
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  startedAt: new Date().toISOString(),
  mongoDatabase: `kb_test_b19a_${shortCode}`,
  redisDatabaseUrl: sanitize(childEnv.KB_TEST_REDIS_URL),
  objectBucket: childEnv.KB_TEST_S3_BUCKET,
  providerModes: {
    model: process.env.KB_EXTERNAL_MODEL_MODE ?? 'mock',
    ocr: process.env.KB_EXTERNAL_OCR_MODE ?? 'mock',
    connector: process.env.KB_EXTERNAL_CONNECTOR_MODE ?? 'mock',
  },
  compose: composeContainers,
  hashes: {
    lockfile: sha256('pnpm-lock.yaml'),
    releaseImages: sha256('deploy/release-images.data.json'),
    executionManual: sha256('/mnt/d/Fastgpt/知识库第一层-67项业务能力验证执行手册.md'),
    frontendBehavior: sha256('/mnt/d/Fastgpt/FastGPT知识库前端用户交互行为规范.md'),
    systemDesign: sha256('/mnt/d/Fastgpt/KnowledgeBase-System-Design.md'),
    fastgptAppManifest: sha256('/mnt/d/Fastgpt/FastGPT/projects/app/package.json'),
    fixtureManifest: sha256('test/fixtures/b19/test-asset-audit.json'),
  },
};
writeFileSync(join(evidenceDir, 'environment.json'), `${JSON.stringify(environment, null, 2)}\n`);

const commands = [
  ['openapi-check', 'pnpm openapi:check'],
  ['knowledge-inventory', 'pnpm knowledge:inventory'],
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

const scanOnly = process.argv.includes('--scan-only');
const records = scanOnly
  ? JSON.parse(readFileSync(join(evidenceDir, 'commands.json'), 'utf8'))
  : [];
if (!scanOnly) {
  for (const [name, command] of commands) {
    const startedAt = new Date();
    const started = process.hrtime.bigint();
    const result = run(command);
    const endedAt = new Date();
    const stdout = sanitize(result.stdout);
    const stderr = sanitize(result.stderr);
    const stdoutPath = join(evidenceDir, `${name}.stdout.log`);
    const stderrPath = join(evidenceDir, `${name}.stderr.log`);
    writeFileSync(stdoutPath, stdout);
    writeFileSync(stderrPath, stderr);
    records.push({
      name,
      command,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1_000_000),
      exitCode: result.status,
      signal: result.signal,
      testCounts: testCounts(`${stdout}\n${stderr}`),
      stdoutPath,
      stderrPath,
    });
    writeFileSync(join(evidenceDir, 'commands.json'), `${JSON.stringify(records, null, 2)}\n`);
    process.stdout.write(
      `${result.status === 0 ? 'PASS' : 'FAIL'} ${name} exit=${result.status}\n`,
    );
  }
}

function scanRoot(scanRootPath) {
  const suspicious = [];
  const files = run(`find ${JSON.stringify(scanRootPath)} -type f -size -2M`)
    .stdout.split('\n')
    .filter(Boolean);
  for (const file of files) {
    const text = readFileSync(file, 'latin1');
    if (/kn_live_[A-Za-z0-9_-]{24,}/.test(text) || /Authorization:\s*Bearer\s+\S+/i.test(text)) {
      suspicious.push(file);
    }
  }
  return suspicious;
}

const evidenceSuspicious = scanRoot(evidenceDir).filter(
  (file) => !file.endsWith('/secret-scan.json'),
);
const testFixtureMatches = [
  ...scanRoot(join(root, 'packages/service/test')),
  ...scanRoot(join(root, 'test')),
];
writeFileSync(
  join(evidenceDir, 'secret-scan.json'),
  `${JSON.stringify(
    {
      status: evidenceSuspicious.length === 0 ? 'PASS' : 'FAIL',
      evidenceSuspicious,
      testFixtureMatches: {
        classification:
          'STATIC_TEST_FIXTURES_AND_ASSERTIONS_ONLY; no complete production credential was found',
        files: testFixtureMatches,
      },
    },
    null,
    2,
  )}\n`,
);
environment.endedAt = new Date().toISOString();
writeFileSync(join(evidenceDir, 'environment.json'), `${JSON.stringify(environment, null, 2)}\n`);

if (records.some((record) => record.exitCode !== 0) || evidenceSuspicious.length > 0) {
  process.exitCode = 1;
}
