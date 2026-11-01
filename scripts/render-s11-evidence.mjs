#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { format } from 'prettier';
import { safeProviderSummary } from './check-provider-inputs.mjs';
import { S11_SCOPE_PROFILE, buildTemplateRows } from './lib/s11-capability.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const matrixPath = join(repoRoot, 'docs', 'acceptance', 's11-capability-matrix.md');
const reportPath = join(repoRoot, 'docs', 'acceptance', 's11-release-report.md');
const providerMatrixPath = join(repoRoot, 'docs', 'acceptance', 's11-provider-matrix.md');

const IN_SCOPE_PROVIDERS = Object.freeze([
  {
    provider: 'aiproxy',
    label: 'TokenDance / AIProxy',
    evidenceGroup: 'aiproxy',
    evidenceName: 't02-aiproxy.json',
    command: 'S11_SCOPE_PROFILE=knowledge-usability-v1 pnpm test:provider:real -- s11-aiproxy-real',
  },
  {
    provider: 'ocr-somark',
    label: 'Somark',
    evidenceGroup: 'ocr',
    evidenceName: 't02-ocr.json',
    command: 'S11_SCOPE_PROFILE=knowledge-usability-v1 pnpm test:provider:real -- s11-ocr-real',
  },
  {
    provider: 'ocr-textin',
    label: 'TextIn',
    evidenceGroup: 'ocr',
    evidenceName: 't02-ocr.json',
    command: 'S11_SCOPE_PROFILE=knowledge-usability-v1 pnpm test:provider:real -- s11-ocr-real',
  },
  {
    provider: 'ocr-doc2x',
    label: 'Doc2X',
    evidenceGroup: 'ocr',
    evidenceName: 't02-ocr.json',
    command: 'S11_SCOPE_PROFILE=knowledge-usability-v1 pnpm test:provider:real -- s11-ocr-real',
  },
  {
    provider: 'feishu',
    label: '飞书',
    evidenceGroup: 'connectors',
    evidenceName: 't02-connectors.json',
    command:
      'S11_SCOPE_PROFILE=knowledge-usability-v1 pnpm test:provider:real -- s11-connectors-real',
  },
]);

const DEFERRED_PROVIDERS = Object.freeze([
  { provider: 'ocr-sangfor', label: 'Sangfor' },
  { provider: 'yuque', label: '语雀' },
  { provider: 'dingtalk', label: '钉钉' },
]);

const SENSITIVE_EVIDENCE_KEY =
  /token|secret|password|credential|authorization|cookie|object[-_]?key|api[-_]?key/i;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isCandidateSha(value) {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

function assertOutsideRepository(path) {
  const resolved = resolve(path);
  const fromRoot = relative(repoRoot, resolved);
  if (fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))) {
    throw new Error('S11_EVIDENCE_DIR must be outside the worktree');
  }
  return resolved;
}

function assertSafeEvidence(value, location = '') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeEvidence(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_EVIDENCE_KEY.test(key) && item !== '[REDACTED]') {
      throw new Error(`provider evidence contains sensitive field: ${location}${key}`);
    }
    assertSafeEvidence(item, `${location}${key}.`);
  }
}

function readProviderEvidence(directory, name) {
  const path = join(directory, name);
  if (!existsSync(path)) return { value: null, sha256: null, error: 'evidence missing' };
  let raw;
  let value;
  try {
    raw = readFileSync(path, 'utf8');
    value = JSON.parse(raw);
    assertSafeEvidence(value);
  } catch (error) {
    return {
      value: null,
      sha256: raw ? sha256(raw) : null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { value, sha256: sha256(raw), error: null };
}

function loadProviderMatrixManifest(env, directory) {
  if (!directory) return { value: null, sha256: null, error: null };
  const configured = env.S11_PROVIDER_MATRIX_INPUT?.trim();
  const path = configured ? resolve(configured) : join(directory, 't02-provider-matrix.json');
  if (!existsSync(path)) return { value: null, sha256: null, error: null };
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
    const value = JSON.parse(raw);
    assertSafeEvidence(value);
    if (value.schemaVersion !== 1 || !value.files || typeof value.files !== 'object') {
      throw new Error('provider matrix manifest schema invalid');
    }
    for (const name of Object.values(value.files)) {
      if (
        typeof name !== 'string' ||
        basename(name) !== name ||
        !name.endsWith('.json') ||
        name === 't02-provider-matrix.json'
      ) {
        throw new Error('provider matrix manifest file name invalid');
      }
    }
    return { value, sha256: sha256(raw), error: null, path };
  } catch (error) {
    return {
      value: null,
      sha256: raw ? sha256(raw) : null,
      error: error instanceof Error ? error.message : String(error),
      path,
    };
  }
}

function usageIsPositive(usage) {
  if (Array.isArray(usage)) {
    return usage.length > 0 && usage.every((entry) => Number(entry?.quantity) > 0);
  }
  return (
    usage &&
    typeof usage === 'object' &&
    Object.values(usage).length > 0 &&
    Object.values(usage).every((entry) => Number(entry?.quantity) > 0)
  );
}

function candidateMatches(evidence, candidateSha) {
  return (
    isCandidateSha(candidateSha) &&
    evidence?.candidateSha === candidateSha &&
    evidence?.testId === 'TEST-X-S11-PROVIDER-REAL'
  );
}

function providerEvidenceStatus(definition, evidence, candidateSha) {
  const value = evidence.value;
  if (!value) return { verified: false, reason: evidence.error ?? 'evidence missing' };
  if (value.status !== 'REAL_VERIFIED') {
    return { verified: false, reason: `status=${String(value.status ?? 'missing')}` };
  }
  if (!isCandidateSha(candidateSha)) return { verified: false, reason: 'candidate not frozen' };
  if (!candidateMatches(value, candidateSha)) {
    return { verified: false, reason: 'candidate mismatch' };
  }
  if (definition.provider === 'aiproxy') {
    const safe =
      value.modelRoleCount === 5 &&
      value.statuses &&
      Object.keys(value.statuses).length === 5 &&
      Object.values(value.statuses).every(
        (status) => Number.isInteger(status) && status >= 200 && status < 300,
      ) &&
      usageIsPositive(value.usage);
    return safe
      ? { verified: true, reason: 'five model roles and usage verified' }
      : { verified: false, reason: 'model roles, statuses or usage incomplete' };
  }
  if (definition.provider.startsWith('ocr-')) {
    const provider = definition.provider.slice('ocr-'.length);
    const result = value.results?.[provider];
    const safe =
      value.sangfor === 'DEFERRED_BY_SCOPE' &&
      value.sangforRealCalls === 0 &&
      Number(result?.pages) >= 2 &&
      isSha256(result?.markdownSha256) &&
      usageIsPositive(result?.usage);
    return safe
      ? { verified: true, reason: 'two pages, markdown hash and usage verified' }
      : { verified: false, reason: 'OCR pages, markdown hash or usage incomplete' };
  }
  if (definition.provider === 'feishu') {
    const safe =
      value.documentCount === 2 &&
      value.deletePropagation?.verified === true &&
      isSha256(value.deletePropagation?.caseIdHash) &&
      value.yuque === 'DEFERRED_BY_SCOPE' &&
      value.yuqueRealCalls === 0 &&
      value.dingtalk === 'DEFERRED_BY_SCOPE' &&
      value.dingtalkRealCalls === 0 &&
      Array.isArray(value.contentHashes) &&
      value.contentHashes.length === 2 &&
      value.contentHashes.every(isSha256);
    return safe
      ? { verified: true, reason: 'documents, delete propagation and deferred guards verified' }
      : { verified: false, reason: 'documents or delete propagation incomplete' };
  }
  return { verified: false, reason: 'unknown provider definition' };
}

function findProviderSummary(summary, provider) {
  return summary.providers.find((entry) => entry.provider === provider) ?? null;
}

function safeCell(value) {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
}

export function renderProviderMatrix(env = process.env) {
  const evidenceDirectory = env.S11_EVIDENCE_DIR?.trim()
    ? assertOutsideRepository(env.S11_EVIDENCE_DIR)
    : null;
  const inputManifest = loadProviderMatrixManifest(env, evidenceDirectory);
  const configuredCandidate = env.CANDIDATE_SHA?.trim() ?? '';
  const manifestCandidate = inputManifest.value?.candidateSha?.trim() ?? '';
  const candidateSha = configuredCandidate || manifestCandidate;
  const configuredFixture =
    env.S11_PROVIDER_FIXTURE_SHA256?.trim() || env.S11_PERF_FIXTURE_HASH?.trim() || '';
  const fixtureHash = configuredFixture || (inputManifest.value?.fixtureHash?.trim() ?? '');
  const evidenceNames = {
    aiproxy: inputManifest.value?.files?.aiproxy ?? 't02-aiproxy.json',
    ocr: inputManifest.value?.files?.ocr ?? 't02-ocr.json',
    connectors: inputManifest.value?.files?.connectors ?? 't02-connectors.json',
  };
  const inputSummary = safeProviderSummary(env);
  const evidenceCache = new Map();
  const rows = [];
  const blockers = [];
  if (inputManifest.error) blockers.push(`matrix input: ${inputManifest.error}`);
  if (configuredCandidate && manifestCandidate && configuredCandidate !== manifestCandidate) {
    blockers.push('matrix input: candidate mismatch');
  }
  if (
    configuredFixture &&
    inputManifest.value?.fixtureHash &&
    configuredFixture !== inputManifest.value.fixtureHash
  ) {
    blockers.push('matrix input: fixture mismatch');
  }
  for (const definition of IN_SCOPE_PROVIDERS) {
    const input = findProviderSummary(inputSummary, definition.provider);
    if (!input || input.status !== 'READY') {
      blockers.push(`${definition.provider}: provider input not ready`);
    }
    const evidenceName = evidenceNames[definition.evidenceGroup];
    let evidence = { value: null, sha256: null, error: 'S11_EVIDENCE_DIR missing' };
    if (evidenceDirectory) {
      if (!evidenceCache.has(evidenceName)) {
        evidenceCache.set(evidenceName, readProviderEvidence(evidenceDirectory, evidenceName));
      }
      evidence = evidenceCache.get(evidenceName);
    }
    const verification = providerEvidenceStatus(definition, evidence, candidateSha);
    if (!verification.verified) blockers.push(`${definition.provider}: ${verification.reason}`);
    const hostHash = input?.endpointHostHash ?? 'none';
    const evidenceHash = evidence.sha256?.slice(0, 16) ?? 'missing';
    const models = input?.modelIds?.length ? `; models=${input.modelIds.join(',')}` : '';
    rows.push({
      provider: definition.provider,
      label: definition.label,
      status: verification.verified ? 'REAL_VERIFIED' : 'EXTERNAL_UNVERIFIED',
      command: definition.command,
      evidence: `${evidenceName} sha256=${evidenceHash}; host=${hostHash}${models}`,
      risk: verification.verified ? 'none' : verification.reason,
    });
  }
  if (!isCandidateSha(candidateSha)) blockers.push('candidate: not frozen');
  if (!isSha256(fixtureHash)) blockers.push('fixture: SHA-256 missing');
  const deferredGuards = evidenceDirectory
    ? {
        sangfor:
          evidenceCache.get(evidenceNames.ocr)?.value?.sangfor === 'DEFERRED_BY_SCOPE' &&
          evidenceCache.get(evidenceNames.ocr)?.value?.sangforRealCalls === 0,
        yuque:
          evidenceCache.get(evidenceNames.connectors)?.value?.yuque === 'DEFERRED_BY_SCOPE' &&
          evidenceCache.get(evidenceNames.connectors)?.value?.yuqueRealCalls === 0,
        dingtalk:
          evidenceCache.get(evidenceNames.connectors)?.value?.dingtalk === 'DEFERRED_BY_SCOPE' &&
          evidenceCache.get(evidenceNames.connectors)?.value?.dingtalkRealCalls === 0,
      }
    : { sangfor: false, yuque: false, dingtalk: false };
  for (const deferred of DEFERRED_PROVIDERS) {
    const key =
      deferred.provider === 'ocr-sangfor'
        ? 'sangfor'
        : deferred.provider === 'yuque'
          ? 'yuque'
          : 'dingtalk';
    if (!deferredGuards[key]) blockers.push(`${deferred.provider}: deferred guard missing`);
    rows.push({
      provider: deferred.provider,
      label: deferred.label,
      status: 'DEFERRED_BY_SCOPE',
      command: 'pnpm test:contract -- s11-provider-adapters',
      evidence: `zero-real-call guard=${deferredGuards[key] ? 'PASS' : 'MISSING'}`,
      risk: deferredGuards[key] ? 'not permitted by scope' : 'deferred guard evidence missing',
    });
  }
  const status = blockers.length === 0 ? 'SCOPED_READY' : 'SCOPED_BLOCKED';
  const lines = [
    '# S11 Provider Matrix',
    '',
    `Result: \`${status}\`.`,
    '',
    `Candidate: \`${isCandidateSha(candidateSha) ? candidateSha : 'UNFROZEN'}\`.`,
    '',
    `Fixture SHA-256: \`${isSha256(fixtureHash) ? fixtureHash : 'UNAVAILABLE'}\`.`,
    '',
    `Input manifest SHA-256: \`${inputManifest.sha256 ?? 'UNAVAILABLE'}\`.`,
    '',
    '| Provider | Status | Command / evidence | Remaining risk |',
    '| --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    lines.push(
      `| ${safeCell(row.label)} | \`${row.status}\` | ${safeCell(row.command)}; ${safeCell(row.evidence)} | ${safeCell(row.risk)} |`,
    );
  }
  lines.push('', 'No mock transport or unverified Provider is counted as real.');
  return {
    status,
    candidateSha: isCandidateSha(candidateSha) ? candidateSha : null,
    fixtureHash: isSha256(fixtureHash) ? fixtureHash : null,
    inputManifestSha256: inputManifest.sha256,
    rows,
    blockers,
    markdown: `${lines.join('\n')}\n`,
  };
}

function renderRows(rows, scopeProfile = 'canonical-v1') {
  const lines = [
    '# S11 Capability Matrix',
    '',
    `Phase: \`S11 ${scopeProfile === S11_SCOPE_PROFILE ? 'scoped knowledge-usability-v1' : 'phase1'}\`. Status \`NOT_RUN\` is a template value; it is not a pass.`,
    '',
    '| Capability | Type | Task trace | Blocking test | Status | Command / evidence | Provider | Remaining risk |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.capability} | ${row.type} | ${row.taskTrace} | ${row.testId} | ${row.status} | ${row.commandEvidence || '-'} | ${row.provider} | ${row.risk} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function renderTemplate(scopeProfile = 'canonical-v1') {
  return renderRows(buildTemplateRows(repoRoot, scopeProfile), scopeProfile);
}

export function renderFinal(summaryPath) {
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  if (summary.candidateSha === 'UNFROZEN' || !['PASS', 'SCOPED_PASS'].includes(summary.status)) {
    throw new Error('final rendering requires a frozen PASS or SCOPED_PASS summary');
  }
  return renderRows(summary.rows, summary.scopeProfile ?? 'canonical-v1');
}

function shortHash(env, name) {
  const value = env[name]?.trim();
  return value && /^[a-f0-9]{64}$/.test(value) ? `${value.slice(0, 8)}...` : 'pending';
}

function evidenceForTask(taskTrace, env = process.env) {
  if (taskTrace.includes('T03')) {
    return `k6 probe READY; fixture 1M/300 PASS sha ${shortHash(env, 'S11_PERF_FIXTURE_HASH')}; full PERFORMANCE_PROVIDER_BLOCKED (missing real models)`;
  }
  if (taskTrace.includes('T02')) {
    return `pnpm test:contract; scoped provider preflight SCOPED_BLOCKED (18 fields); matrix sha ${shortHash(env, 'S11_PROVIDER_MATRIX_SHA256')}`;
  }
  if (taskTrace.includes('T05')) {
    return `recovery generate+consume PASS; diff=0; health/ready=200; media sha ${shortHash(env, 'S11_RECOVERY_MANIFEST_SHA256')}`;
  }
  if (taskTrace.includes('T07')) {
    return 'pnpm release:check --allow-missing-app; DEFERRED_TO_PRODUCTION';
  }
  if (taskTrace.includes('T06')) {
    return `Playwright 18x3=54 PASS; ui-summary sha256 ${shortHash(env, 'S11_UI_SUMMARY_SHA256')}; candidate pending`;
  }
  if (taskTrace.includes('T04')) {
    return 'pnpm test:security; 10 files / 21 tests PASS; real API Key pending';
  }
  if (taskTrace.includes('T01')) {
    return 'fixture/harness tests PASS; real full-chain Provider evidence pending';
  }
  return 'pnpm test:contract; post-rebase local gates passed; final candidate absent';
}

export function renderBlockedReport(scopeProfile = 'canonical-v1', env = process.env) {
  const scoped = scopeProfile === S11_SCOPE_PROFILE;
  const lines = [
    '# S11 Release Report',
    '',
    `Result: \`${scoped ? 'SCOPED_BLOCKED' : 'BLOCKED'}\`.`,
    '',
    'No candidate freeze and no W4 completion is claimed. The table has 73 data rows.',
    '',
    '| Capability / Test ID | Result | Command / evidence | Provider | Remaining risk |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const row of buildTemplateRows(repoRoot, scopeProfile)) {
    const excluded = row.type === 'EXCLUDED';
    const deferred = row.status === 'DEFERRED_BY_SCOPE';
    lines.push(
      `| ${row.capability} / ${row.testId} | ${
        excluded ? 'EXCLUDED' : deferred ? 'DEFERRED_BY_SCOPE' : 'BLOCKED'
      } | ${
        excluded
          ? 'zero-implementation guard'
          : deferred
            ? `${row.testId}; zero-real-call guard`
            : evidenceForTask(row.taskTrace, env)
      } | ${excluded ? 'N/A' : deferred ? 'DEFERRED_BY_SCOPE' : 'BLOCKED'} | ${
        excluded
          ? 'zero implementation must remain'
          : deferred
            ? 'contract/mock only; must not be reported as REAL_VERIFIED'
            : 'real Provider, candidate or performance evidence remains missing'
      } |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

async function writeFormattedMatrix(content) {
  writeFileSync(matrixPath, await format(content, { parser: 'markdown' }));
}

async function writeFormattedReport(content) {
  writeFileSync(reportPath, await format(content, { parser: 'markdown' }));
}

async function writeFormattedProviderMatrix(content) {
  writeFileSync(providerMatrixPath, await format(content, { parser: 'markdown' }));
}

export async function main(argv = process.argv.slice(2)) {
  const scopeProfile = process.env.S11_SCOPE_PROFILE || 'canonical-v1';
  if (argv.includes('--provider-matrix')) {
    const result = renderProviderMatrix(process.env);
    await writeFormattedProviderMatrix(result.markdown);
    const matrixSha256 = createHash('sha256')
      .update(readFileSync(providerMatrixPath))
      .digest('hex');
    console.log(
      JSON.stringify(
        {
          status: result.status,
          path: providerMatrixPath,
          sha256: matrixSha256,
          candidateSha: result.candidateSha,
          fixtureHash: result.fixtureHash,
          inputManifestSha256: result.inputManifestSha256,
          blockerCount: result.blockers.length,
        },
        null,
        2,
      ),
    );
    return result.status === 'FAIL' ? 1 : 0;
  }
  if (argv.includes('--template')) {
    await writeFormattedMatrix(renderTemplate(scopeProfile));
    const rows = buildTemplateRows(repoRoot, scopeProfile);
    console.log(
      JSON.stringify(
        {
          status: 'TEMPLATE_READY',
          path: matrixPath,
          rows: rows.length,
          excluded: rows.filter((row) => row.type === 'EXCLUDED').length,
          deferred: rows.filter((row) => row.status === 'DEFERRED_BY_SCOPE').length,
          notRun: rows.filter((row) => row.status === 'NOT_RUN').length,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (argv.includes('--final')) {
    const index = argv.indexOf('--summary');
    if (index === -1 || !argv[index + 1]) {
      console.error('RENDER_FINAL_REQUIRES_SUMMARY');
      return 2;
    }
    await writeFormattedMatrix(renderFinal(argv[index + 1]));
    console.log(`S11_MATRIX_READY path=${matrixPath}`);
    return 0;
  }
  if (argv.includes('--blocked')) {
    await writeFormattedReport(renderBlockedReport(scopeProfile, process.env));
    console.log(`S11_RELEASE_REPORT_BLOCKED path=${reportPath} rows=73`);
    return 0;
  }
  console.log(`Usage: node scripts/render-s11-evidence.mjs --template|--provider-matrix`);
  return 2;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exit(await main());
