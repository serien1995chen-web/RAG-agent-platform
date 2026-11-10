import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const runId = process.env.B02_RUN_ID ?? 'b02-manual';
const outputDir = join(root, 'test-results', 'b02', runId);
const logDir = join(outputDir, 'logs');

const commands = [
  ['baseline-openapi', 'pnpm openapi:check'],
  ['baseline-inventory', 'pnpm knowledge:inventory'],
  ['baseline-runtime', 'pnpm knowledge:check-runtime'],
  ['baseline-typecheck', 'pnpm typecheck'],
  [
    'baseline-service',
    'pnpm --filter @kb/service exec vitest run test/integration/knowledge-application.test.ts test/integration/knowledge-catalog-governance.test.ts test/integration/knowledge-infrastructure.test.ts',
  ],
  [
    'baseline-service-application',
    'pnpm --filter @kb/service exec vitest run test/integration/knowledge-application.test.ts',
  ],
  [
    'baseline-service-governance',
    'pnpm --filter @kb/service exec vitest run test/integration/knowledge-catalog-governance.test.ts',
  ],
  [
    'baseline-service-infrastructure',
    'pnpm --filter @kb/service exec vitest run test/integration/knowledge-infrastructure.test.ts',
  ],
  ['baseline-search', 'pnpm --filter @kb/search exec vitest run test/unit/s7-filter.test.ts'],
  [
    'baseline-contract',
    'pnpm exec vitest run --config test/contract/vitest.config.ts test/contract/s7-filter-contract.test.ts',
  ],
  [
    'baseline-web',
    'pnpm --filter @kb/web exec vitest run test/unit/fastgpt-product-detail-state.test.ts',
  ],
  [
    'baseline-tenant',
    'pnpm exec vitest run --config test/tenant/vitest.config.ts test/tenant/knowledge-tenant.test.ts',
  ],
  [
    'baseline-concurrency',
    'pnpm exec vitest run --config test/concurrency/vitest.config.ts test/concurrency/knowledge-cas.test.ts',
  ],
  [
    'b02-service',
    'pnpm --filter @kb/service exec vitest run test/integration/kb-b02-catalog-tags.test.ts',
  ],
  ['b02-search', 'pnpm --filter @kb/search exec vitest run test/unit/s7-filter.test.ts'],
  [
    'b02-contract',
    'pnpm exec vitest run --config test/contract/vitest.config.ts test/contract/s7-filter-contract.test.ts',
  ],
  [
    'b02-web',
    'pnpm --filter @kb/web exec vitest run test/unit/fastgpt-product-detail-state.test.ts',
  ],
  [
    'b02-tenant',
    'pnpm exec vitest run --config test/tenant/vitest.config.ts test/tenant/knowledge-tenant.test.ts',
  ],
  [
    'b02-concurrency',
    'pnpm exec vitest run --config test/concurrency/vitest.config.ts test/concurrency/kb-b02-catalog-tags.test.ts',
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
  ['integration', 'pnpm test:integration'],
  ['tenant', 'pnpm test:tenant'],
  ['concurrency', 'pnpm test:concurrency'],
  ['build', 'pnpm build'],
  ['build-workers', 'pnpm build:workers'],
  [
    'b02-e2e',
    'pnpm exec vitest run --config test/e2e/vitest.config.ts test/e2e/kb-b02-catalog-tags.test.ts',
  ],
  ['e2e', 'pnpm test:e2e'],
];

const redact = (value) =>
  value
    .replace(/(mongodb(?:\+srv)?:\/\/)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(postgres(?:ql)?:\/\/)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(redis:\/\/)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(authorization:\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key[=:]\s*)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(secret[_-]?key[=:]\s*)[^\s"']+/gi, '$1[REDACTED]');

function run(command) {
  return new Promise((resolveRun) => {
    const startedAt = new Date().toISOString();
    const child = spawn('bash', ['-c', command], {
      cwd: root,
      env: {
        ...process.env,
        KB_ENV: 'test',
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
const requested = new Set(
  process.env.B02_GATES?.split(',')
    .map((name) => name.trim())
    .filter(Boolean),
);
const selected = commands.filter(([name]) => requested.size === 0 || requested.has(name));
if (requested.size > 0 && selected.length !== requested.size) {
  throw new Error(
    `unknown B02 gate: ${[...requested].filter((name) => !commands.some(([entry]) => entry === name)).join(',')}`,
  );
}

const commandsPath = join(outputDir, 'commands.json');
const existing =
  process.env.B02_GATES && process.env.B02_APPEND === '1'
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
  await writeFile(commandsPath, JSON.stringify(results, null, 2));
}

process.exitCode = results.some((result) => result.exitCode !== 0) ? 1 : 0;
