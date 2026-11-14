import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../../..');
const runIdArg = process.argv.find((value) => value.startsWith('--run-id='));
const runId =
  runIdArg?.slice('--run-id='.length) ??
  new Date()
    .toISOString()
    .replaceAll(/[-:TZ.]/g, '')
    .slice(0, 14);
const outputDir = join(root, 'test-results', 'b07', runId);
mkdirSync(join(outputDir, 'logs'), { recursive: true });

const commands = [
  ['openapi:check', ['pnpm', 'openapi:check']],
  ['knowledge:inventory', ['pnpm', 'knowledge:inventory']],
  ['knowledge:check-runtime', ['pnpm', 'knowledge:check-runtime']],
  ['architecture:check', ['pnpm', 'architecture:check']],
  ['forbidden-files:check', ['pnpm', 'forbidden-files:check']],
  ['typecheck', ['pnpm', 'typecheck']],
  [
    'archive-integration',
    [
      'pnpm',
      '--filter',
      '@kb/service',
      'exec',
      'vitest',
      'run',
      'test/integration/knowledge-archive.test.ts',
    ],
  ],
  [
    'lifecycle-integration',
    [
      'pnpm',
      '--filter',
      '@kb/service',
      'exec',
      'vitest',
      'run',
      'test/integration/knowledge-file-lifecycle.test.ts',
    ],
  ],
  [
    'ops-integration',
    [
      'pnpm',
      '--filter',
      '@kb/service',
      'exec',
      'vitest',
      'run',
      'test/integration/s10-ops.test.ts',
      'test/unit/s10-ops-worker.test.ts',
    ],
  ],
  [
    'fault',
    [
      'pnpm',
      'exec',
      'vitest',
      'run',
      '--config',
      'test/fault/vitest.config.ts',
      'test/fault/knowledge-file-fault.test.ts',
      'test/fault/s10-ops-fault.test.ts',
      'test/fault/s11-provider-fault.test.ts',
    ],
  ],
  [
    'tenant',
    [
      'pnpm',
      'exec',
      'vitest',
      'run',
      '--config',
      'test/tenant/vitest.config.ts',
      'test/tenant/knowledge-file-tenant.test.ts',
      'test/tenant/s10-ops-tenant.test.ts',
      'test/tenant/kb-b03a-acl-tenant.test.ts',
    ],
  ],
  [
    'concurrency',
    [
      'pnpm',
      'exec',
      'vitest',
      'run',
      '--config',
      'test/concurrency/vitest.config.ts',
      'test/concurrency/knowledge-upload.test.ts',
      'test/concurrency/s6-job-fencing.test.ts',
    ],
  ],
  [
    'security',
    [
      'pnpm',
      'exec',
      'vitest',
      'run',
      '--config',
      'test/security/vitest.config.ts',
      'test/security/s11-upload-archive.test.ts',
      'test/security/kb-b06a-upload-security.test.ts',
      'test/security/s11-secret-leak.test.ts',
      'test/security/s10-audit-redaction.test.ts',
    ],
  ],
  [
    'recovery',
    [
      'pnpm',
      'exec',
      'vitest',
      'run',
      '--config',
      'test/recovery/vitest.config.ts',
      'test/recovery/s11-invariants.test.ts',
      'test/recovery/s11-component-faults.test.ts',
    ],
  ],
  [
    'e2e-baseline',
    [
      'pnpm',
      'exec',
      'vitest',
      'run',
      '--config',
      'test/e2e/vitest.config.ts',
      'test/e2e/knowledge-file.test.ts',
      'test/e2e/s10-ops-admin.test.ts',
    ],
  ],
  [
    'e2e-b07',
    [
      'pnpm',
      'exec',
      'vitest',
      'run',
      '--config',
      'test/e2e/vitest.config.ts',
      'test/e2e/kb-b07-archive-lifecycle.test.ts',
    ],
  ],
];

const results = [];
for (const [name, command] of commands) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command[0], command.slice(1), {
    cwd: root,
    env: { ...process.env, B07_RUN_ID: runId },
    encoding: 'utf8',
  });
  const finishedAt = new Date().toISOString();
  const log = [
    `command: ${command.join(' ')}`,
    `startedAt: ${startedAt}`,
    `finishedAt: ${finishedAt}`,
    `exitCode: ${result.status ?? -1}`,
    '',
    result.stdout ?? '',
    result.stderr ?? '',
  ].join('\n');
  writeFileSync(join(outputDir, 'logs', `${name}.log`), log);
  results.push({
    name,
    command: command.join(' '),
    exitCode: result.status ?? -1,
    startedAt,
    finishedAt,
    log: `logs/${name}.log`,
  });
}

const summary = {
  schemaVersion: 1,
  batch: 'B07',
  runId,
  generatedAt: new Date().toISOString(),
  completed: results.filter((result) => result.exitCode === 0).length,
  failed: results.filter((result) => result.exitCode !== 0).length,
  results,
};
writeFileSync(join(outputDir, 'gate-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (summary.failed > 0) process.exitCode = 1;
