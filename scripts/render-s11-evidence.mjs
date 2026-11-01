#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { format } from 'prettier';
import { S11_SCOPE_PROFILE, buildTemplateRows } from './lib/s11-capability.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const matrixPath = join(repoRoot, 'docs', 'acceptance', 's11-capability-matrix.md');

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

async function writeFormattedMatrix(content) {
  writeFileSync(matrixPath, await format(content, { parser: 'markdown' }));
}

export async function main(argv = process.argv.slice(2)) {
  const scopeProfile = process.env.S11_SCOPE_PROFILE || 'canonical-v1';
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
  console.log(`Usage: node scripts/render-s11-evidence.mjs --template`);
  return 2;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exit(await main());
