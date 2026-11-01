#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { cpus, totalmem, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
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
  if (!value || !value.startsWith('kb_s11_')) {
    throw new Error('isolated target must start with the kb_s11_ prefix');
  }
  return value;
}

function requiredEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function assertOutsideWorktree(path) {
  const resolved = resolve(path);
  const pathFromRoot = relative(repositoryRoot, resolved);
  if (pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))) {
    throw new Error('performance runtime file must stay outside the worktree');
  }
  return resolved;
}

async function apiJson(response, operation) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
  if (!response.ok || payload?.success !== true || payload.data === undefined) {
    throw new Error(
      `${operation} failed status=${response.status} code=${payload?.error?.code ?? 'UNKNOWN'}`,
    );
  }
  return payload.data;
}

async function createSpace(input) {
  const response = await globalThis.fetch(`${input.baseUrl}/v1/knowledge/spaces`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.bootstrapToken}`,
      'x-workspace-id': input.workspaceId,
      'content-type': 'application/json',
      'idempotency-key': `${input.seed}-space`,
    },
    body: JSON.stringify({
      kind: 'space',
      name: `S11 Performance ${input.seed}`,
      accessMode: 'workspace',
      sourceAclMode: 'inherited',
      sourcePermissionEnabled: true,
    }),
  });
  const data = await apiJson(response, 'performance space create');
  if (typeof data.id !== 'string' || data.id.length === 0) throw new Error('space id missing');
  return data.id;
}

async function createApiKey(input) {
  const response = await globalThis.fetch(`${input.baseUrl}/v1/knowledge/api-keys`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.bootstrapToken}`,
      'x-workspace-id': input.workspaceId,
      'content-type': 'application/json',
      'idempotency-key': `${input.seed}-api-key`,
    },
    body: JSON.stringify({
      name: `S11 performance ${input.seed}`,
      scopes: ['knowledge:read', 'knowledge:write', 'knowledge:search', 'knowledge:manage'],
      spaceIds: [input.spaceId],
      expiresAt: null,
    }),
  });
  const data = await apiJson(response, 'performance api key create');
  if (
    typeof data.id !== 'string' ||
    typeof data.secret !== 'string' ||
    typeof data.keyPrefix !== 'string'
  ) {
    throw new Error('performance api key response invalid');
  }
  return data;
}

function writeRuntimeEnvironment(path, values) {
  const target = assertOutsideWorktree(path);
  mkdirSync(resolve(target, '..'), { recursive: true });
  const lines = Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  writeFileSync(target, `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(target, 0o600);
  return target;
}

async function uploadPdf(input) {
  const bytes = readFileSync(input.path);
  const headers = {
    authorization: `Bearer ${input.apiKey}`,
    'x-workspace-id': input.workspaceId,
    'content-type': 'application/json',
    accept: 'application/json',
  };
  const initResponse = await globalThis.fetch(`${input.baseUrl}/v1/knowledge/uploads`, {
    method: 'POST',
    headers: {
      ...headers,
      'idempotency-key': `${input.seed}-upload-${input.index}-init`,
    },
    body: JSON.stringify({
      knowledgeSpaceId: input.spaceId,
      name: input.name,
      mimeType: 'application/pdf',
      sizeBytes: bytes.byteLength,
    }),
  });
  const session = await apiJson(initResponse, `performance upload init ${input.index}`);
  if (typeof session.uploadId !== 'string' || !Number.isInteger(session.partCount)) {
    throw new Error(`performance upload init invalid index=${input.index}`);
  }
  const parts = [];
  if (session.partCount === 1) {
    const presignResponse = await globalThis.fetch(
      `${input.baseUrl}/v1/knowledge/uploads/${session.uploadId}/presign`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'idempotency-key': `${input.seed}-upload-${input.index}-presign`,
        },
        body: JSON.stringify({ partNumbers: [1] }),
      },
    );
    const presigned = await apiJson(presignResponse, `performance upload presign ${input.index}`);
    const upload = presigned.uploads?.[0];
    if (!upload?.url || !upload?.headers) throw new Error('performance presign response invalid');
    const put = await globalThis.fetch(upload.url, {
      method: 'PUT',
      headers: upload.headers,
      body: bytes,
    });
    if (!put.ok) throw new Error(`performance object put failed status=${put.status}`);
  } else {
    for (let partNumber = 1; partNumber <= session.partCount; partNumber += 1) {
      const start = (partNumber - 1) * session.partSizeBytes;
      const response = await globalThis.fetch(
        `${input.baseUrl}/v1/knowledge/uploads/${session.uploadId}/parts/${partNumber}`,
        {
          method: 'PUT',
          headers: {
            ...headers,
            'content-type': 'application/octet-stream',
            'idempotency-key': `${input.seed}-upload-${input.index}-part-${partNumber}`,
          },
          body: bytes.subarray(start, Math.min(start + session.partSizeBytes, bytes.byteLength)),
        },
      );
      const data = await apiJson(response, `performance upload part ${input.index}/${partNumber}`);
      parts.push({ partNumber, etag: data.etag });
    }
  }
  const completeResponse = await globalThis.fetch(
    `${input.baseUrl}/v1/knowledge/uploads/${session.uploadId}/complete`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'idempotency-key': `${input.seed}-upload-${input.index}-complete`,
      },
      body: JSON.stringify({ parts }),
    },
  );
  const completed = await apiJson(completeResponse, `performance upload complete ${input.index}`);
  if (typeof completed.blobId !== 'string') throw new Error('performance blob id missing');
  return completed.blobId;
}

async function uploadPdfs(input) {
  const results = new Array(input.files.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(10, input.files.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= input.files.length) return;
      results[index] = await uploadPdf({ ...input, ...input.files[index], index });
    }
  });
  await Promise.all(workers);
  return results;
}

export function seedSegments(input) {
  const database = assertIsolatedTarget(input.database);
  if (!/^[0-9a-f]{24}$/i.test(input.spaceId)) throw new Error('space id is invalid');
  if (typeof input.workspaceId !== 'string' || input.workspaceId.length === 0) {
    throw new Error('workspace id is required');
  }
  const composeFile = input.composeFile ?? join(repositoryRoot, 'deploy', 'docker-compose.yml');
  const script = `
const target = db.getSiblingDB(${JSON.stringify(database)});
const workspaceId = ${JSON.stringify(input.workspaceId)};
const knowledgeSpaceId = ObjectId(${JSON.stringify(input.spaceId)});
const sourceId = ObjectId();
const memberId = "mem_s11_perf_seed";
const total = ${input.segmentCount};
const batchSize = 10000;
const existing = target.knowledge_segments.countDocuments({ workspaceId });
if (existing > total) throw new Error("segment count already exceeds target");
let inserted = existing;
while (inserted < total) {
  const batch = [];
  const end = Math.min(total, inserted + batchSize);
  for (let index = inserted; index < end; index += 1) {
    const text = "S11 performance segment " + index + " release evidence retrieval";
    batch.push({
      workspaceId,
      knowledgeSpaceId,
      version: 1,
      deletedAt: null,
      createdByMemberId: memberId,
      updatedByMemberId: memberId,
      sourceId,
      sourceVersion: 1,
      searchEnabled: true,
      order: index,
      question: "performance query " + index,
      answer: text,
      content: text,
      fullTextTokens: text,
      fullTextVersion: 1,
      metadata: { title: "S11 performance", order: index },
      history: [],
      indexes: [],
      indexStatus: "indexed",
      indexErrorCode: null,
      imageBlobRefId: null,
      imageDescription: null,
      synonymVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    });
  }
  target.knowledge_segments.insertMany(batch, { ordered: false });
  inserted = end;
}
print(JSON.stringify({ count: target.knowledge_segments.countDocuments({ workspaceId }) }));
`;
  const result = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      composeFile,
      'exec',
      '-T',
      'mongo',
      'mongosh',
      `mongodb://mongo:27017/${database}?replicaSet=rs0`,
      '--quiet',
      '--eval',
      script,
    ],
    {
      encoding: 'utf8',
      env: input.env,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `segment seed failed status=${result.status} detail=${String(result.stderr).slice(0, 500)}`,
    );
  }
  const lines = String(result.stdout).trim().split(/\r?\n/).filter(Boolean);
  let parsed;
  for (const line of lines.reverse()) {
    try {
      parsed = JSON.parse(line);
      break;
    } catch {
      // Mongosh may print informational lines before the final JSON result.
    }
  }
  if (!parsed || parsed.count !== input.segmentCount) {
    throw new Error(`segment seed count mismatch: ${String(parsed?.count ?? 'unknown')}`);
  }
  return { count: parsed.count, database };
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

export async function prepareFullFixtures(input) {
  const staged = prepareFixtures(input);
  const env = input.env;
  const baseUrl = requiredEnv(env, 'S11_PERF_BASE_URL').replace(/\/+$/, '');
  const workspaceId = requiredEnv(env, 'S11_PERF_WORKSPACE_ID');
  const bootstrapToken = requiredEnv(env, 'S11_PERF_BOOTSTRAP_TOKEN');
  const database = assertIsolatedTarget(requiredEnv(env, 'S11_PERF_DATABASE'));
  const spaceId =
    env.S11_PERF_SPACE_ID?.trim() ||
    (await createSpace({ baseUrl, workspaceId, bootstrapToken, seed: input.seed }));
  let apiKey = env.S11_PERF_API_KEY?.trim();
  let apiKeyPrefix = 'provided';
  let runtimeEnvFile = null;
  if (!apiKey) {
    const runtimePath = requiredEnv(env, 'S11_PERF_RUNTIME_ENV');
    const created = await createApiKey({
      baseUrl,
      workspaceId,
      bootstrapToken,
      spaceId,
      seed: input.seed,
    });
    apiKey = created.secret;
    apiKeyPrefix = created.keyPrefix;
    runtimeEnvFile = writeRuntimeEnvironment(runtimePath, {
      S11_PERF_BASE_URL: baseUrl,
      S11_PERF_WORKSPACE_ID: workspaceId,
      S11_PERF_SPACE_ID: spaceId,
      S11_PERF_API_KEY: apiKey,
    });
  }
  const pdfFiles = staged.manifest.pdfDirectory
    ? Array.from({ length: input.pdfCount }, (_, index) => {
        const name = `s11-import-${String(index).padStart(3, '0')}.pdf`;
        return { name, path: join(staged.manifest.pdfDirectory, name) };
      })
    : [];
  const uploadIds = await uploadPdfs({
    baseUrl,
    workspaceId,
    spaceId,
    apiKey,
    seed: input.seed,
    files: pdfFiles,
  });
  writeFileSync(staged.manifest.uploadIdsFile, `${JSON.stringify(uploadIds, null, 2)}\n`);
  const seeded = seedSegments({
    database,
    workspaceId,
    spaceId,
    segmentCount: input.segmentCount,
    env,
    composeFile: env.S11_PERF_COMPOSE_FILE,
  });
  const manifest = {
    ...staged.manifest,
    spaceId,
    workspaceId,
    apiKeyPrefix,
    runtimeEnvFile,
    database,
    uploadIdCount: uploadIds.length,
    segmentCountActual: seeded.count,
    seedVerified: true,
    createdAt: new Date().toISOString(),
    runtime: hardwareMetadata(),
  };
  writeFileSync(
    join(staged.evidenceDir, 'fixture-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { ...staged, manifest };
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
    const input = {
      profile: 'standard',
      seed: 's11-performance-v1',
      segmentCount: 1_000_000,
      pdfCount: 300,
      pagesPerPdf: 20,
      env: process.env,
    };
    const mode = process.env.S11_PERF_FIXTURE_MODE?.trim() || 'metadata';
    if (mode === 'full') {
      const result = await prepareFullFixtures(input);
      console.log(
        JSON.stringify(
          {
            status: 'READY',
            readyForFull: true,
            fixtureHash: result.manifest.fixtureHash,
            manifest: join(result.evidenceDir, 'fixture-manifest.json'),
            pdfCount: result.manifest.pdfCount,
            uploadIdCount: result.manifest.uploadIdCount,
            segmentCountActual: result.manifest.segmentCountActual,
            quotaProfile: result.manifest.quotaProfile,
          },
          null,
          2,
        ),
      );
      console.log('PERFORMANCE_FIXTURE_READY');
      process.exit(0);
    }
    const result = prepareFixtures(input);
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
