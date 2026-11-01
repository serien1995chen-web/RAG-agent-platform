#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeK6Scenario, normalizePerformanceResult } from './lib/performance-summary.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');

function blocked(code, message, exitCode = 2) {
  console.error(`${code}: ${message}`);
  return exitCode;
}

export function resolveK6(env = process.env) {
  const configured = env.K6_BIN?.trim();
  if (configured) {
    if (!isAbsolute(configured) || !existsSync(configured)) return null;
    return configured;
  }
  const result = spawnSync('sh', ['-c', 'command -v k6'], {
    encoding: 'utf8',
    env,
  });
  const resolved = result.status === 0 ? result.stdout.trim() : '';
  return resolved || null;
}

export function probeK6(k6Binary, env = process.env) {
  const version = spawnSync(k6Binary, ['version'], {
    encoding: 'utf8',
    env,
  });
  return {
    available: version.status === 0,
    version: version.status === 0 ? version.stdout.trim().split('\n')[0] : null,
  };
}

function insideRepository(path) {
  const pathRelative = relative(repositoryRoot, path);
  return pathRelative === '' || (!pathRelative.startsWith('..') && !isAbsolute(pathRelative));
}

function evidenceDirectory(env) {
  const configured = env.S11_EVIDENCE_DIR?.trim();
  const path = configured ? resolve(configured) : mkdtempSync(join(tmpdir(), 's11-performance-'));
  if (insideRepository(path)) throw new Error('S11_EVIDENCE_DIR must be outside the worktree');
  mkdirSync(path, { recursive: true });
  return path;
}

async function probeReady(baseUrl) {
  if (!baseUrl) return false;
  try {
    const response = await globalThis.fetch(`${baseUrl.replace(/\/+$/, '')}/readyz`, {
      signal: globalThis.AbortSignal.timeout(5_000),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

function runK6(input) {
  const summaryPath = join(input.evidenceDir, `${input.scenario.name}-summary.json`);
  const args = [
    'run',
    '--quiet',
    '--summary-export',
    summaryPath,
    '-e',
    `S11_PERF_BASE_URL=${input.env.S11_PERF_BASE_URL ?? ''}`,
    '-e',
    `S11_PERF_WORKSPACE_ID=${input.env.S11_PERF_WORKSPACE_ID ?? ''}`,
    '-e',
    `S11_PERF_API_KEY=${input.env.S11_PERF_API_KEY ?? ''}`,
    '-e',
    `S11_PERF_SPACE_ID=${input.env.S11_PERF_SPACE_ID ?? ''}`,
    '-e',
    `S11_PERF_UPLOAD_IDS_FILE=${input.env.S11_PERF_UPLOAD_IDS_FILE ?? ''}`,
    '-e',
    `S11_PERF_IMPORT_FILES=${input.env.S11_PERF_IMPORT_FILES ?? '300'}`,
    input.scenario.path,
  ];
  const startedAt = Date.now();
  const result = spawnSync(input.k6Binary, args, {
    encoding: 'utf8',
    env: input.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const elapsedSeconds = Number(((Date.now() - startedAt) / 1_000).toFixed(3));
  if (result.status !== 0 || !existsSync(summaryPath)) {
    return { status: 'FAIL', elapsedSeconds, summaryPath, output: result.stderr };
  }
  return {
    status: 'READY',
    elapsedSeconds,
    summaryPath,
    summary: JSON.parse(readFileSync(summaryPath, 'utf8')),
    output: result.stderr,
  };
}

function scenarioFiles() {
  return [
    {
      name: 'search',
      kind: 'search',
      path: join(repositoryRoot, 'test', 'performance', 'k6', 'search.js'),
    },
    {
      name: 'deep',
      kind: 'deep',
      path: join(repositoryRoot, 'test', 'performance', 'k6', 'deep.js'),
    },
    {
      name: 'import',
      kind: 'import',
      path: join(repositoryRoot, 'test', 'performance', 'k6', 'import.js'),
    },
  ];
}

export function validateFullFixture(manifest, env = process.env) {
  const errors = [];
  if (manifest.segmentCount !== 1_000_000 || manifest.segmentCountActual !== 1_000_000) {
    errors.push('segment_count_1m_required');
  }
  if (manifest.seedVerified !== true) errors.push('segment_seed_unverified');
  const uploadIdsPath = manifest.uploadIdsFile || env.S11_PERF_UPLOAD_IDS_FILE;
  if (!uploadIdsPath || !existsSync(uploadIdsPath)) {
    errors.push('upload_ids_file_missing');
  } else {
    try {
      const uploadIds = JSON.parse(readFileSync(uploadIdsPath, 'utf8'));
      if (!Array.isArray(uploadIds) || uploadIds.length !== manifest.pdfCount) {
        errors.push('upload_ids_count_mismatch');
      } else if (
        uploadIds.some((value) => typeof value !== 'string' || value.trim() === '') ||
        new Set(uploadIds).size !== uploadIds.length
      ) {
        errors.push('upload_ids_invalid_or_duplicate');
      }
    } catch {
      errors.push('upload_ids_json_invalid');
    }
  }
  return errors;
}

export async function main(env = process.env) {
  const mode = env.S11_PERF_MODE?.trim() || 'full';
  const profile = env.S11_PERF_PROFILE?.trim() || 'standard';
  if (!['probe', 'full'].includes(mode)) {
    return blocked('PERFORMANCE_CONFIG_INVALID', `unsupported S11_PERF_MODE=${mode}`);
  }
  if (profile !== 'standard') {
    return blocked('PERFORMANCE_CONFIG_INVALID', `unsupported S11_PERF_PROFILE=${profile}`);
  }
  const k6Binary = resolveK6(env);
  if (!k6Binary) {
    return blocked(
      'PERFORMANCE_K6_UNAVAILABLE',
      'k6 is absent from K6_BIN and PATH; no Node fallback is used',
      127,
    );
  }
  const k6 = probeK6(k6Binary, env);
  if (!k6.available) {
    return blocked('PERFORMANCE_K6_UNAVAILABLE', 'k6 version probe failed', 127);
  }
  if (!(await probeReady(env.S11_PERF_BASE_URL))) {
    return blocked('PERFORMANCE_STACK_UNAVAILABLE', '/readyz is not 200', 3);
  }
  if (mode === 'probe') {
    console.log(
      JSON.stringify(
        {
          status: 'READY',
          profile,
          k6: k6.version,
          candidateSha: env.S11_PERF_CANDIDATE_SHA ?? null,
        },
        null,
        2,
      ),
    );
    console.log('PERFORMANCE_READY');
    return 0;
  }

  for (const name of [
    'S11_PERF_BASE_URL',
    'S11_PERF_WORKSPACE_ID',
    'S11_PERF_API_KEY',
    'S11_PERF_SPACE_ID',
    'S11_PERF_UPLOAD_IDS_FILE',
    'S11_PERF_LLM_MODEL',
    'S11_PERF_EMBEDDING_MODEL',
    'S11_PERF_RERANK_MODEL',
    'S11_PERF_VLM_MODEL',
    'S11_PERF_VISION_EMBEDDING_MODEL',
  ]) {
    if (!env[name]?.trim()) {
      return blocked('PERFORMANCE_PROVIDER_BLOCKED', `missing ${name}`, 4);
    }
  }
  let evidenceDir;
  try {
    evidenceDir = evidenceDirectory(env);
  } catch (error) {
    return blocked(
      'PERFORMANCE_FIXTURE_FAILED',
      error instanceof Error ? error.message : String(error),
      5,
    );
  }
  const fixtureManifestPath = env.S11_PERF_FIXTURE_MANIFEST?.trim();
  if (!fixtureManifestPath || !existsSync(fixtureManifestPath)) {
    return blocked('PERFORMANCE_FIXTURE_FAILED', 'fixture manifest is missing', 5);
  }
  const fixtureManifest = JSON.parse(readFileSync(fixtureManifestPath, 'utf8'));
  const fixtureErrors = validateFullFixture(fixtureManifest, env);
  if (fixtureErrors.length > 0) {
    return blocked('PERFORMANCE_FIXTURE_FAILED', fixtureErrors.join(','), 5);
  }
  const scenarios = {};
  for (const scenario of scenarioFiles()) {
    const run = runK6({ k6Binary, env, evidenceDir, scenario });
    if (run.status !== 'READY') {
      writeFileSync(
        join(evidenceDir, `${scenario.name}-stderr.txt`),
        String(run.output ?? '').slice(-20_000),
      );
      return blocked('PERFORMANCE_THRESHOLD_FAILED', `${scenario.name} k6 run failed`, 1);
    }
    scenarios[scenario.name] = normalizeK6Scenario(run.summary, {
      kind: scenario.kind,
      files: Number(env.S11_PERF_IMPORT_FILES ?? fixtureManifest.pdfCount ?? 300),
      pagesPerFile: fixtureManifest.pagesPerPdf ?? 20,
      parseConcurrency: fixtureManifest.parseConcurrency ?? 10,
      elapsedSeconds: scenario.kind === 'import' ? run.elapsedSeconds : null,
    });
  }
  const summary = normalizePerformanceResult({
    candidateSha: env.S11_PERF_CANDIDATE_SHA ?? 'UNFROZEN',
    profile,
    fixtureHash: fixtureManifest.fixtureHash,
    hardware: fixtureManifest.hardware,
    runtime: {
      ...fixtureManifest.runtime,
      k6: k6.version,
    },
    models: {
      llm: env.S11_PERF_LLM_MODEL,
      embedding: env.S11_PERF_EMBEDDING_MODEL,
      rerank: env.S11_PERF_RERANK_MODEL,
      vlm: env.S11_PERF_VLM_MODEL,
      visionEmbedding: env.S11_PERF_VISION_EMBEDDING_MODEL,
    },
    scenarios,
  });
  writeFileSync(join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  if (summary.status !== 'PASS') {
    return blocked('PERFORMANCE_THRESHOLD_FAILED', summary.blockers.join(','), 1);
  }
  console.log(`PERFORMANCE_PASS summary=${join(evidenceDir, 'summary.json')}`);
  return 0;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const exitCode = await main();
  process.exit(exitCode);
}
