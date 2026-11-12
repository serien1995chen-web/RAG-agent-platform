import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const runId = process.env.B05_RUN_ID ?? 'b05-manual';
const outputDir = join(root, 'test-results', 'b05', runId);
const logDir = join(outputDir, 'logs');
const reportDir = join(outputDir, 'vitest');
const binDir = join(outputDir, 'bin');
const nodeBin = '/home/archer/.nvm/versions/node/v22.23.2/bin';
const localBin = join(root, 'node_modules', '.bin');

const reporters = (name) =>
  `--reporter=default --reporter=junit --reporter=json --outputFile.junit=${join(
    reportDir,
    `${name}-junit.xml`,
  )} --outputFile.json=${join(reportDir, `${name}.json`)}`;

const commands = [
  [
    'baseline-existing-import',
    'pnpm --filter @kb/service exec vitest run test/integration/knowledge-import.test.ts',
  ],
  [
    'baseline-existing-data',
    'pnpm --filter @kb/service exec vitest run test/integration/knowledge-application.test.ts test/integration/kb-b04-segment-index.test.ts',
  ],
  [
    'baseline-archive',
    'pnpm --filter @kb/service exec vitest run test/integration/knowledge-archive.test.ts',
  ],
  [
    'b05-service-data',
    `pnpm --filter @kb/service exec vitest run test/integration/kb-b05-manual-data.test.ts ${reporters('b05-service-data')}`,
  ],
  [
    'b05-service-ing',
    `pnpm --filter @kb/service exec vitest run test/integration/knowledge-import.test.ts -t "L1-B05-ING-002" ${reporters('b05-service-ing')}`,
  ],
  [
    'b05-tenant',
    `pnpm exec vitest run --config test/tenant/vitest.config.ts test/tenant/kb-b05-manual-data-tenant.test.ts ${reporters('b05-tenant')}`,
  ],
  [
    'b05-concurrency',
    `pnpm exec vitest run --config test/concurrency/vitest.config.ts test/concurrency/knowledge-import-idempotency.test.ts -t "L1-B05-ING-002" ${reporters('b05-concurrency')}`,
  ],
  [
    'b05-security',
    `pnpm exec vitest run --config test/security/vitest.config.ts test/security/kb-b05-manual-data-security.test.ts ${reporters('b05-security')}`,
  ],
  [
    'b05-contract',
    `pnpm exec vitest run --config test/contract/vitest.config.ts test/contract/kb-b05-manual-data-contract.test.ts ${reporters('b05-contract')}`,
  ],
  [
    'b05-e2e',
    `B05_RESULT_DIR=${join(outputDir, 'ui')} pnpm exec vitest run --config test/e2e/vitest.config.ts test/e2e/kb-b05-manual-data.test.ts ${reporters('b05-e2e')}`,
  ],
  [
    'provider-real',
    'S11_SCOPE_PROFILE=knowledge-usability-v1 S11_EVIDENCE_DIR=/tmp/b05-provider-20261112-185054 pnpm test:provider:real -- s11-aiproxy-real',
  ],
  ['lint', 'pnpm lint'],
  ['format-check', 'pnpm format:check'],
  ['typecheck', 'pnpm typecheck'],
  ['architecture-check', 'pnpm architecture:check'],
  ['forbidden-files-check', 'pnpm forbidden-files:check'],
  ['openapi-check', 'pnpm openapi:check'],
  ['knowledge-inventory', 'pnpm knowledge:inventory'],
  ['knowledge-check-runtime', 'pnpm knowledge:check-runtime'],
  ['unit', 'pnpm test:unit'],
  ['contract', 'pnpm test:contract'],
  ['security', 'pnpm test:security'],
  ['integration', 'pnpm test:integration'],
  ['tenant', 'pnpm test:tenant'],
  ['concurrency', 'pnpm test:concurrency'],
  ['fault', 'pnpm test:fault'],
  ['build', 'pnpm build'],
  ['build-workers', 'pnpm build:workers'],
  ['e2e', 'pnpm test:e2e'],
  ['reconcile', 'node test/fixtures/b05/reconcile.mjs'],
];

const redact = (value) =>
  value
    .replace(/(mongodb(?:\+srv)?:\/\/)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(postgres(?:ql)?:\/\/)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(redis:\/\/)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(authorization:\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key[=:]\s*)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(secret[_-]?key[=:]\s*)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(objectKey["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1[REDACTED]');

function run(command) {
  return new Promise((resolveRun) => {
    const startedAt = new Date().toISOString();
    const child = spawn('bash', ['-lc', command], {
      cwd: root,
      env: {
        ...process.env,
        CI: '1',
        KB_ENV: 'test',
        KB_EXTERNAL_MODEL_MODE: 'mock',
        KB_TEST_MONGO_URI:
          process.env.KB_TEST_MONGO_URI ??
          'mongodb://127.0.0.1:27017/kb_test?replicaSet=rs0&directConnection=true',
        KB_TEST_REDIS_URL: process.env.KB_TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/0',
        KB_TEST_PG_URL:
          process.env.KB_TEST_PG_URL ?? 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb',
        KB_TEST_S3_ENDPOINT: process.env.KB_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
        KB_TEST_S3_REGION: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
        KB_TEST_S3_BUCKET: process.env.KB_TEST_S3_BUCKET ?? 'kb-test',
        KB_TEST_S3_ACCESS_KEY: process.env.KB_TEST_S3_ACCESS_KEY ?? 'minioadmin',
        KB_TEST_S3_SECRET_KEY: process.env.KB_TEST_S3_SECRET_KEY ?? 'minioadmin',
        PATH: `${binDir}:${nodeBin}:${localBin}:/usr/local/bin:/usr/bin:/bin`,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('close', (exitCode) => {
      resolveRun({
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode: exitCode ?? 1,
        stdout: redact(stdout),
        stderr: redact(stderr),
      });
    });
  });
}

await mkdir(logDir, { recursive: true });
await mkdir(reportDir, { recursive: true });
const requested = new Set(
  process.env.B05_GATES?.split(',')
    .map((name) => name.trim())
    .filter(Boolean),
);
const selected = commands.filter(([name]) => requested.size === 0 || requested.has(name));
if (requested.size > 0 && selected.length !== requested.size) {
  throw new Error(
    `unknown B05 gate: ${[...requested]
      .filter((name) => !commands.some(([entry]) => entry === name))
      .join(',')}`,
  );
}

const commandsPath = join(outputDir, 'commands.json');
const existing =
  process.env.B05_GATES && process.env.B05_APPEND === '1'
    ? JSON.parse(await readFile(commandsPath, 'utf8').catch(() => '[]'))
    : [];
const selectedNames = new Set(selected.map(([name]) => name));
const results = existing.filter((result) => !selectedNames.has(result.name));

for (const [name, command] of selected) {
  process.stdout.write(`\n==> ${name}: ${command}\n`);
  const result = await run(command);
  const logPath = join('logs', `${name}.log`);
  await writeFile(
    join(outputDir, logPath),
    `$ ${command}\n\n${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`,
  );
  results.push({
    name,
    command,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    exitCode: result.exitCode,
    log: logPath,
  });
  await writeFile(commandsPath, `${JSON.stringify(results, null, 2)}\n`);
}

process.exitCode = results.some((result) => result.exitCode !== 0) ? 1 : 0;
