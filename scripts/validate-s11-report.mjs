#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  S11_CROSS_TEST_IDS,
  S11_DEFERRED_CAPABILITY_IDS,
  S11_EXCLUDED_IDS,
  S11_SCOPE_PROFILE,
  buildTemplateRows,
  developmentTestIds,
  scopedDevelopmentTestIds,
} from './lib/s11-capability.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const matrixPath = join(repoRoot, 'docs', 'acceptance', 's11-capability-matrix.md');
export const EXPECTED_69_IDS = Object.freeze(developmentTestIds(repoRoot));
export const EXPECTED_33_CROSS_IDS = S11_CROSS_TEST_IDS;
export const EXCLUDED_GUARDS = Object.freeze(S11_EXCLUDED_IDS.map((id) => `TEST-EXCLUDED-${id}`));

export function parseMatrix(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => /^\| [A-Z]+-\d{3} /.test(line))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}

export function validateTemplate(text, scopeProfile = 'canonical-v1') {
  const rows = parseMatrix(text);
  const ids = rows.map((row) => row[0]);
  const errors = [];
  if (rows.length !== 73) errors.push(`73 rows expected, got ${rows.length}`);
  if (new Set(ids).size !== ids.length) errors.push('duplicate capability rows');
  if (rows.filter((row) => row[1] === 'EXCLUDED').length !== 4) errors.push('4 EXCLUDED expected');
  const deferred = scopeProfile === S11_SCOPE_PROFILE ? S11_DEFERRED_CAPABILITY_IDS.length : 0;
  const notRun = scopeProfile === S11_SCOPE_PROFILE ? 66 : 69;
  if (rows.filter((row) => row[4] === 'NOT_RUN').length !== notRun)
    errors.push(`${notRun} NOT_RUN expected`);
  if (rows.filter((row) => row[4] === 'DEFERRED_BY_SCOPE').length !== deferred)
    errors.push(`${deferred} DEFERRED_BY_SCOPE expected`);
  if (rows.some((row) => row[4] === 'PASS')) errors.push('template must not contain PASS');
  const known = new Set(buildTemplateRows(repoRoot, scopeProfile).map((row) => row.capability));
  for (const id of ids) if (!known.has(id)) errors.push(`unknown capability ${id}`);
  return { rows: rows.length, errors, ids };
}

export function assertScopeGuard() {
  const sourceRoots = [
    join(repoRoot, 'packages', 'service', 'src'),
    join(repoRoot, 'packages', 'contracts', 'src'),
    join(repoRoot, 'projects', 'app', 'src'),
  ];
  const forbidden = [
    'recursive crawler',
    'crawl scheduler',
    'audio knowledge index',
    'video keyframe',
    'media retrieval',
  ];
  const hits = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx|mjs|json)$/.test(entry.name)) continue;
      const text = readFileSync(path, 'utf8').toLowerCase();
      for (const fragment of forbidden)
        if (text.includes(fragment)) hits.push(`${path}: ${fragment}`);
    }
  };
  for (const root of sourceRoots) walk(root);
  return { hits, status: hits.length === 0 ? 'PASS' : 'FAIL' };
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function main(argv = process.argv.slice(2)) {
  const scopeProfile = process.env.S11_SCOPE_PROFILE || 'canonical-v1';
  const deferred = scopeProfile === S11_SCOPE_PROFILE ? S11_DEFERRED_CAPABILITY_IDS.length : 0;
  if (argv.includes('--self-test')) {
    const result = validateTemplate(readFileSync(matrixPath, 'utf8'), scopeProfile);
    const scope = assertScopeGuard();
    console.log(JSON.stringify({ ...result, scope }, null, 2));
    return result.errors.length === 0 && scope.status === 'PASS' ? 0 : 1;
  }
  if (argv.includes('--all')) {
    const result = validateTemplate(readFileSync(matrixPath, 'utf8'), scopeProfile);
    const scope = assertScopeGuard();
    const expectedIds =
      scopeProfile === S11_SCOPE_PROFILE ? scopedDevelopmentTestIds(repoRoot) : EXPECTED_69_IDS;
    const expectedCovered = expectedIds.every((id) =>
      result.ids.includes(id.replace(/^TEST-/, '').replace(/-BLOCK$/, '')),
    );
    console.log(
      JSON.stringify(
        {
          scopeProfile,
          tests69: expectedIds.length,
          deferredCapabilities: deferred,
          cross33: EXPECTED_33_CROSS_IDS.length,
          excluded4: EXCLUDED_GUARDS.length,
          expectedCovered,
          errors: result.errors,
          scope,
          status: result.errors.length === 0 && scope.status === 'PASS' ? 'READY' : 'FAIL',
        },
        null,
        2,
      ),
    );
    return result.errors.length === 0 && scope.status === 'PASS' ? 0 : 1;
  }
  if (argv.includes('--final')) {
    const candidate = optionValue(argv, '--candidate');
    const summaryPath = optionValue(argv, '--summary');
    if (!candidate || !summaryPath) {
      console.error('FINAL_REQUIRES_CANDIDATE_AND_SUMMARY');
      return 2;
    }
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    const expectedStatus = scopeProfile === S11_SCOPE_PROFILE ? 'SCOPED_PASS' : 'PASS';
    const statusOk = summary.status === expectedStatus && summary.candidateSha === candidate;
    console.log(
      JSON.stringify(
        {
          status: statusOk ? 'PASS' : 'FAIL',
          scopeProfile,
          candidate,
          summaryStatus: summary.status,
        },
        null,
        2,
      ),
    );
    return statusOk ? 0 : 1;
  }
  console.error('Usage: node scripts/validate-s11-report.mjs --self-test|--all|--final');
  return 2;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exit(main());
