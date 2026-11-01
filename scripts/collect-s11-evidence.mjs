#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildKnowledgeContractArtifacts } from '../packages/contracts/src/openapi/openapi-builder.mjs';
import { safeProviderSummary } from './check-provider-inputs.mjs';
import {
  S11_CROSS_TEST_IDS,
  S11_EXCLUDED_IDS,
  S11_SCOPE_PROFILE,
  buildTemplateRows,
  scopeCounts,
} from './lib/s11-capability.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const SENSITIVE_KEY =
  /token|secret|password|credential|authorization|cookie|object[-_]?key|api[-_]?key/i;
const TASK_IDS = new Set(
  Array.from({ length: 8 }, (_, index) => `S11-T${String(index + 1).padStart(2, '0')}`),
);

export function redactEvidence(value, keyHint = '') {
  if (SENSITIVE_KEY.test(keyHint)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactEvidence(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactEvidence(item, key)]),
    );
  }
  return value;
}

export function captureHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function runCommand(command, input = {}) {
  return {
    command,
    exitCode: input.exitCode ?? null,
    keyResult: input.keyResult ?? '',
    outputSha256: input.output ? captureHash(input.output) : null,
  };
}

export function appendTest(tests, input) {
  if (!input.id || !input.result) throw new Error('test id and result are required');
  tests.push({
    id: input.id,
    result: input.result,
    evidencePath: input.evidencePath ?? null,
  });
}

function isCandidateSha(value) {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

function isTaskId(value) {
  return typeof value === 'string' && TASK_IDS.has(value);
}

export function collectAll(env = process.env, task = null) {
  const artifacts = buildKnowledgeContractArtifacts(repoRoot);
  const scopeProfile = env.S11_SCOPE_PROFILE || 'canonical-v1';
  const rows = buildTemplateRows(repoRoot, scopeProfile);
  const counts = scopeCounts(repoRoot, scopeProfile);
  const providers = safeProviderSummary(env);
  const configuredCandidate = env.CANDIDATE_SHA?.trim() ?? '';
  const candidateSha = isCandidateSha(configuredCandidate) ? configuredCandidate : 'UNFROZEN';
  const blockers = [];
  if (providers.status !== 'READY') {
    blockers.push({
      code:
        providers.status === 'SCOPED_BLOCKED' ? 'SCOPED_PROVIDER_BLOCKED' : 'REAL_PROVIDER_BLOCKED',
      task: 'S11-T02',
      detail: [...providers.missingFields, ...providers.invalidFields].join(','),
    });
  }
  const k6 = spawnSync('k6', ['version'], { encoding: 'utf8', env });
  if (k6.status !== 0) {
    blockers.push({
      code: 'PERFORMANCE_K6_UNAVAILABLE',
      task: 'S11-T03',
      detail: 'k6 is absent from PATH',
    });
  }
  if (env.S10_MERGE_SHA !== 'd7e38c71293a283cd6268605b5036e8ee5763c9a') {
    blockers.push({
      code: 'S10_MERGE_REQUIRED',
      task: 'S11-T01/T04/T08',
      detail: 'S10_MERGE_SHA must be d7e38c71293a283cd6268605b5036e8ee5763c9a',
    });
  }
  if (scopeProfile === S11_SCOPE_PROFILE && !isCandidateSha(configuredCandidate)) {
    blockers.push({
      code: 'SCOPED_CANDIDATE_UNFROZEN',
      task: 'S11-T08',
      detail: 'CANDIDATE_SHA must be a frozen 40 or 64 character hexadecimal SHA',
    });
  }
  if (task !== null && !isTaskId(task)) {
    throw new Error(`unknown S11 task: ${String(task)}`);
  }
  const taskSuffix = task?.slice('S11-'.length);
  const selectedRows = task
    ? rows.filter((row) => row.taskTrace.split('/').includes(taskSuffix))
    : rows;
  return {
    schemaVersion: 1,
    wave: 'W4',
    stage: 'S11',
    owner: 'personA',
    phase: scopeProfile === S11_SCOPE_PROFILE ? 'scoped' : 'phase1',
    scopeProfile,
    candidateSha,
    s10MergeSha: env.S10_MERGE_SHA ?? null,
    generatedAt: new Date().toISOString(),
    task,
    contract: artifacts.actualCounts,
    runtime: artifacts.runtimeRegistry.count,
    deferred: artifacts.deferredManifest.count,
    capabilities: counts,
    rows: selectedRows,
    rowCount: selectedRows.length,
    providers,
    crossTestIds: S11_CROSS_TEST_IDS,
    deferredCrossTestIds: scopeProfile === S11_SCOPE_PROFILE ? ['TEST-X-SAAS-READY'] : [],
    excludedIds: S11_EXCLUDED_IDS,
    commands: [],
    testIds: [],
    blockers,
    status:
      blockers.length > 0
        ? scopeProfile === S11_SCOPE_PROFILE
          ? 'SCOPED_BLOCKED'
          : 'BLOCKED'
        : 'SCOPED_READY',
  };
}

function evidenceDirectory(env) {
  const path = resolve(env.S11_EVIDENCE_DIR || join(tmpdir(), 's11-evidence'));
  mkdirSync(path, { recursive: true });
  return path;
}

export function selfTest() {
  const redacted = redactEvidence({
    provider: 'feishu',
    token: 'secret-token',
    nested: { objectKey: 'private/key', modelId: 'model-1' },
  });
  if (redacted.token !== '[REDACTED]') throw new Error('token redaction failed');
  if (redacted.nested.objectKey !== '[REDACTED]') throw new Error('object key redaction failed');
  if (redacted.nested.modelId !== 'model-1') throw new Error('safe field changed');
  if (captureHash('a') !== captureHash('a')) throw new Error('hash is not deterministic');
  return { status: 'PASS', redactedFields: 2 };
}

function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--self-test')) {
    const result = redactEvidence({
      token: 'hidden',
      output: 'safe',
    });
    if (result.token !== '[REDACTED]' || result.output !== 'safe') {
      throw new Error('collector self-test failed');
    }
    console.log(JSON.stringify(selfTest(), null, 2));
    return 0;
  }
  const allowed = new Set(['--all', '--task']);
  if (argv.some((arg) => !allowed.has(arg) && !TASK_IDS.has(arg))) {
    console.error('S11_EVIDENCE_ARGUMENT_INVALID');
    return 2;
  }
  if (argv.includes('--all') && argv.includes('--task')) {
    console.error('S11_EVIDENCE_TASK_CONFLICT');
    return 2;
  }
  let task = null;
  if (argv.includes('--task')) {
    const index = argv.indexOf('--task');
    task = argv[index + 1];
    if (!isTaskId(task)) {
      console.error('S11_EVIDENCE_TASK_INVALID');
      return 2;
    }
  }
  const summary = redactEvidence(collectAll(env, task));
  const outputDir = evidenceDirectory(env);
  const path = join(outputDir, task ? `${task.toLowerCase()}-summary.json` : 'summary.json');
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: summary.status,
      path,
      task: summary.task,
      rowCount: summary.rowCount,
      blockerCount: summary.blockers.length,
    }),
  );
  return 0;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(
      `S11_EVIDENCE_COLLECTOR_FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
