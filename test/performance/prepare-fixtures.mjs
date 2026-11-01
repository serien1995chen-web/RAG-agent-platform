#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '../..');

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function evidenceDirectory(env) {
  const path = resolve(env.S11_EVIDENCE_DIR || join(tmpdir(), 's11-performance-fixtures'));
  mkdirSync(path, { recursive: true });
  return path;
}

export function assertIsolatedTarget(value) {
  if (!value || !value.includes('kb_s11_')) {
    throw new Error('isolated target must contain the kb_s11_ prefix');
  }
  return value;
}

export function hardwareMetadata() {
  const cpuList = cpus();
  return {
    cpuModel: cpuList[0]?.model ?? 'UNKNOWN',
    logicalCpus: cpuList.length,
    memoryBytes: totalmem(),
    os: process.platform,
    kernel: process.version,
    node: process.version,
    pnpm: process.env.npm_config_user_agent?.match(/pnpm\/[^ ]+/)?.[0] ?? 'UNKNOWN',
    docker: process.env.S11_PERF_DOCKER_VERSION ?? 'UNKNOWN',
    k6: process.env.S11_PERF_K6_VERSION ?? 'UNKNOWN',
  };
}

export function prepareFixtures(input) {
  if (input.profile !== 'standard') throw new Error('only the standard profile is supported');
  if (input.segmentCount !== 1_000_000) throw new Error('segment count must be 1,000,000');
  if (input.pdfCount !== 300) throw new Error('PDF count must be 300');
  if (input.pagesPerPdf !== 20) throw new Error('pages per PDF must be 20');
  const evidenceDir = evidenceDirectory(input.env);
  const sourcePdf = join(
    repositoryRoot,
    'test',
    'fixtures',
    's11',
    'generated',
    's11-import-20-pages.pdf',
  );
  if (!existsSync(sourcePdf)) throw new Error('S11 20-page PDF fixture is missing');
  const pdfDir = join(evidenceDir, 'pdf');
  mkdirSync(pdfDir, { recursive: true });
  const pdfHashes = [];
  for (let index = 0; index < input.pdfCount; index += 1) {
    const name = `s11-import-${String(index).padStart(3, '0')}.pdf`;
    const target = join(pdfDir, name);
    copyFileSync(sourcePdf, target);
    pdfHashes.push({ name, sha256: hash(readFileSync(target)) });
  }
  const databaseTarget = input.env.S11_PERF_DATABASE || 'kb_s11_performance';
  assertIsolatedTarget(databaseTarget);
  const fixtureHash = hash(
    JSON.stringify({
      seed: input.seed,
      segmentCount: input.segmentCount,
      pdfHashes,
      pagesPerPdf: input.pagesPerPdf,
      profile: input.profile,
    }),
  );
  const manifest = {
    schemaVersion: 1,
    profile: input.profile,
    seed: input.seed,
    fixtureHash,
    segmentCount: input.segmentCount,
    segmentCountActual: 0,
    seedVerified: false,
    seedPlan: {
      collection: 'knowledge_segments',
      database: databaseTarget,
      deterministicFromSeed: true,
    },
    pdfCount: input.pdfCount,
    pagesPerPdf: input.pagesPerPdf,
    uploadIdCount: 0,
    parseConcurrency: 10,
    quotaProfile: 's11-perf-v1',
    uploadIdsFile: join(evidenceDir, 'upload-ids.json'),
    pdfDirectory: pdfDir,
    hardware: hardwareMetadata(),
    runtime: hardwareMetadata(),
    createdAt: null,
  };
  writeFileSync(
    join(evidenceDir, 'fixture-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { evidenceDir, manifest };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = new Set(process.argv.slice(2));
  if (
    !args.has('--profile') ||
    process.argv[process.argv.indexOf('--profile') + 1] !== 'standard'
  ) {
    console.error('PERFORMANCE_FIXTURE_FAILED: --profile standard is required');
    process.exit(2);
  }
  try {
    const result = prepareFixtures({
      profile: 'standard',
      seed: 's11-performance-v1',
      segmentCount: 1_000_000,
      pdfCount: 300,
      pagesPerPdf: 20,
      env: process.env,
    });
    console.log(
      JSON.stringify(
        {
          status: 'STAGED',
          readyForFull: false,
          fixtureHash: result.manifest.fixtureHash,
          manifest: join(result.evidenceDir, 'fixture-manifest.json'),
          pdfCount: result.manifest.pdfCount,
          segmentCount: result.manifest.segmentCount,
          quotaProfile: result.manifest.quotaProfile,
          uploadIdCount: result.manifest.uploadIdCount,
          segmentCountActual: result.manifest.segmentCountActual,
        },
        null,
        2,
      ),
    );
    console.error(
      'PERFORMANCE_FIXTURE_BLOCKED: 300 upload IDs and 1,000,000 seeded Segments are required',
    );
    process.exit(3);
  } catch (error) {
    console.error(
      `PERFORMANCE_FIXTURE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
