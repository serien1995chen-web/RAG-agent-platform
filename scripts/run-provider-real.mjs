#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { checkEnvironment } from './check-provider-inputs.mjs';
import { probeCatalog } from './probe-aiproxy-catalog.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');

function requestedScenario(argv) {
  const separator = argv.indexOf('--');
  return separator >= 0 ? argv.slice(separator + 1).join(' ') : '';
}

const SCENARIO_EVIDENCE = Object.freeze({
  's11-aiproxy-real': 't02-aiproxy.json',
  's11-ocr-real': 't02-ocr.json',
  's11-connectors-real': 't02-connectors.json',
});

function evidenceDirectory(env) {
  const configured = env.S11_EVIDENCE_DIR?.trim();
  if (!configured) return null;
  const path = resolve(configured);
  const fromRoot = relative(repositoryRoot, path);
  if (fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))) {
    throw new Error('S11_EVIDENCE_DIR must be outside the worktree');
  }
  return path;
}

export function writeProviderMatrixManifest(
  env,
  scenario,
  exitCode,
  blockers,
  command = scenario ? `pnpm test:provider:real -- ${scenario}` : 'pnpm test:provider:real',
) {
  const directory = evidenceDirectory(env);
  if (!directory) return null;
  const status = blockers.length > 0 ? 'SCOPED_BLOCKED' : exitCode === 0 ? 'REAL_VERIFIED' : 'FAIL';
  const manifest = {
    schemaVersion: 1,
    candidateSha: env.CANDIDATE_SHA?.trim() || 'UNFROZEN',
    fixtureHash:
      env.S11_PROVIDER_FIXTURE_SHA256?.trim() || env.S11_PERF_FIXTURE_HASH?.trim() || null,
    files: {
      aiproxy: 't02-aiproxy.json',
      ocr: 't02-ocr.json',
      connectors: 't02-connectors.json',
    },
    lastRun: {
      scenario: scenario || 'all',
      command,
      exitCode,
      status,
      blockerCount: blockers.length,
      finishedAt: new Date().toISOString(),
    },
  };
  const path = join(directory, 't02-provider-matrix.json');
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

function evidenceBlockers(env, scenario) {
  if (scenario === 's11-provider-quota') return [];
  const scenarios = scenario ? [scenario] : Object.keys(SCENARIO_EVIDENCE);
  const blockers = [];
  for (const name of scenarios) {
    const file = SCENARIO_EVIDENCE[name];
    if (!file) continue;
    const path = join(env.S11_EVIDENCE_DIR, file);
    if (!existsSync(path)) {
      blockers.push(`${name}: evidence missing`);
      continue;
    }
    try {
      const evidence = JSON.parse(readFileSync(path, 'utf8'));
      if (evidence.status !== 'REAL_VERIFIED') {
        blockers.push(`${name}: ${String(evidence.status ?? 'status missing')}`);
      }
    } catch {
      blockers.push(`${name}: evidence invalid`);
    }
  }
  return blockers;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (env.S11_SCOPE_PROFILE !== 'knowledge-usability-v1') {
    console.error('SCOPED_BLOCKED: S11_SCOPE_PROFILE=knowledge-usability-v1 is required');
    return 2;
  }
  const inputs = checkEnvironment(env);
  if (inputs.status !== 'READY') {
    console.error(
      `SCOPED_BLOCKED: ${inputs.missingFields.length + inputs.invalidFields.length} provider fields`,
    );
    if (inputs.missingFields.length > 0) console.error(inputs.missingFields.join(','));
    if (inputs.invalidFields.length > 0) console.error(inputs.invalidFields.join(','));
    return 2;
  }
  if (!env.S11_EVIDENCE_DIR?.trim()) {
    console.error('SCOPED_BLOCKED: S11_EVIDENCE_DIR is required');
    return 2;
  }

  const scenario = requestedScenario(argv);
  if (!scenario || scenario.includes('s11-aiproxy-catalog-preflight')) {
    const catalog = await probeCatalog(env);
    if (catalog.status !== 'READY') {
      console.error(catalog.code);
      return 2;
    }
    if (catalog.requiresUserConfirmation) {
      console.log(JSON.stringify(catalog, null, 2));
      console.error('AIPROXY_MODEL_ALIAS_CONFIRMATION_REQUIRED');
      return 3;
    }
    if (scenario.includes('s11-aiproxy-catalog-preflight')) return 0;
  }

  const result = spawnSync(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      '--config',
      'test/real-provider/vitest.config.ts',
      ...(scenario ? [scenario] : []),
    ],
    {
      cwd: repositoryRoot,
      env,
      encoding: 'utf8',
      stdio: 'inherit',
    },
  );
  const blockers = evidenceBlockers(env, scenario);
  const finalExitCode =
    (result.status ?? 2) !== 0 ? (result.status ?? 2) : blockers.length > 0 ? 2 : 0;
  writeProviderMatrixManifest(env, scenario, finalExitCode, blockers);
  if (finalExitCode !== 0 && (result.status ?? 2) !== 0) return finalExitCode;
  if (blockers.length > 0) {
    console.error(`SCOPED_BLOCKED: ${blockers.join('; ')}`);
    return finalExitCode;
  }
  return finalExitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main());
}
