import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const runId = process.env.B02_RUN_ID ?? process.argv[2];
if (!runId) throw new Error('B02_RUN_ID or first argument is required');
const outputDir = join(root, 'test-results', 'b02', runId);
await mkdir(outputDir, { recursive: true });

function command(file, args, cwd = root) {
  return execFileSync(file, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function sha256(path) {
  const content = await readFile(path);
  return createHash('sha256').update(content).digest('hex');
}

async function fileEntry(path) {
  const absolute = resolve(path);
  const info = await stat(absolute);
  return {
    path,
    bytes: info.size,
    sha256: await sha256(absolute),
  };
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

const fastgptRoot = '/mnt/d/Fastgpt/FastGPT';
const documentation = [
  await fileEntry('/mnt/d/Fastgpt/知识库第一层-67项业务能力验证执行手册.md'),
  await fileEntry('/mnt/d/Fastgpt/FastGPT知识库前端用户交互行为规范(2).md'),
  await fileEntry('/mnt/d/Fastgpt/KnowledgeBase-System-Design.md'),
];
const candidateFiles = [
  'pnpm-lock.yaml',
  'deploy/release-images.data.json',
  'test/fixtures/b02/behavior-matrix.json',
  'test/fixtures/b02/run-gates.mjs',
  'packages/service/test/integration/kb-b02-catalog-tags.test.ts',
  'test/concurrency/kb-b02-catalog-tags.test.ts',
  'test/e2e/kb-b02-catalog-tags.test.ts',
];
const fastgptFiles = [
  'projects/app/package.json',
  'projects/app/src/pages/api/core/dataset/folder/create.ts',
  'projects/app/src/pages/api/core/dataset/collection/create.ts',
  'projects/app/src/pages/api/core/dataset/collection/listV2.ts',
  'projects/app/src/pages/api/core/dataset/collection/paths.ts',
  'projects/app/src/pages/api/core/dataset/collection/delete.ts',
  'projects/app/src/pages/api/core/dataset/collection/update.ts',
  'projects/app/src/pages/api/core/dataset/collection/sync.ts',
  'projects/app/src/pages/api/core/dataset/training/rebuildEmbedding.ts',
  'packages/global/core/dataset/constants.ts',
  'packages/global/core/dataset/type.ts',
  'packages/service/core/dataset/collection/schema.ts',
  'packages/service/core/dataset/collection/tagFilter.ts',
];

const environment = {
  startedAt: new Date().toISOString(),
  timezone: 'Asia/Shanghai',
  branch: command('git', ['branch', '--show-current']),
  head: command('git', ['rev-parse', 'HEAD']),
  worktree: command('git', ['status', '--short', '--untracked-files=all']) || 'clean',
  node: command('node', ['--version']),
  pnpm: command('pnpm', ['--version']),
  docker: command('docker', [
    'compose',
    '-f',
    'deploy/docker-compose.yml',
    'ps',
    '--format',
    'json',
  ])
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .reduce((result, entry) => {
      result[entry.Service] = {
        state: entry.State,
        health: entry.Health,
        image: entry.Image,
      };
      return result;
    }, {}),
};

const fixtures = {
  runId,
  documents: documentation,
  candidateFiles: await Promise.all(candidateFiles.map((path) => fileEntry(join(root, path)))),
  fastgpt: {
    version: '4.17.4',
    gitMetadata: 'absent',
    files: await Promise.all(fastgptFiles.map(async (path) => fileEntry(join(fastgptRoot, path)))),
  },
};

const commandsPath = join(outputDir, 'commands.json');
const commands = JSON.parse(await readFile(commandsPath, 'utf8'));
const commandSummary = {
  total: commands.length,
  passed: commands.filter((entry) => entry.exitCode === 0).length,
  failed: commands.filter((entry) => entry.exitCode !== 0).map((entry) => entry.name),
};

const run = {
  schemaVersion: 1,
  scope: 'knowledge-base-layer-1',
  groupId: 'B02',
  runId,
  candidateSha: process.env.B02_CANDIDATE_SHA ?? environment.head,
  branch: environment.branch,
  timezone: environment.timezone,
  evidenceDirectory: relative(root, outputDir),
  commands: commandSummary,
  capabilities: {
    'COL-001': process.env.B02_COL_001_STATUS ?? 'FAIL',
    'COL-002': process.env.B02_COL_002_STATUS ?? 'PASS',
    'COL-003': process.env.B02_COL_003_STATUS ?? 'FAIL',
  },
  groupStatus: process.env.B02_GROUP_STATUS ?? 'FAIL',
  productImplementationChanged: process.env.B02_PRODUCT_CHANGED === '1',
  testExecutionCommit: process.env.B02_TEST_COMMIT ?? 'pending',
  notes: [
    'FastGPT 4.17.4 was explicitly selected by the user after the frozen 4.17.3 manifest mismatch was found.',
    'The baseline multi-file service invocation was repeated sequentially after an index-build race; isolated reruns passed.',
    'B02 tests intentionally remain failing where product behavior violates the approved reference or contracts.',
  ],
};

await writeFile(join(outputDir, 'environment.json'), `${JSON.stringify(environment, null, 2)}\n`);
await writeFile(join(outputDir, 'fixtures.json'), `${JSON.stringify(fixtures, null, 2)}\n`);
await writeFile(join(outputDir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);

const evidenceFiles = (await walk(outputDir))
  .filter((path) => !path.endsWith('manifest.json') && !path.endsWith('run.json'))
  .sort();
await writeFile(
  join(outputDir, 'manifest.json'),
  `${JSON.stringify(
    await Promise.all(
      evidenceFiles.map(async (path) => ({
        path: relative(outputDir, path),
        bytes: (await stat(path)).size,
        sha256: await sha256(path),
      })),
    ),
    null,
    2,
  )}\n`,
);
