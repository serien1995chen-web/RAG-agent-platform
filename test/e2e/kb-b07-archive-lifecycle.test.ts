import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import type { Connection } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiHeaders, consoleCookie, createSpace } from './s4-app-harness';
import { startB06aApp, type B06aAppHarness } from './b06a-harness';
import { MinioKnowledgeObjectStore } from '../../sdk/storage/src/providers/minio';
import { knowledgeObjectKey } from '../../sdk/storage/src/object-store-contract';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  registerKnowledgeModels,
} from '../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { createKnowledgeMongoConnection } from '../../packages/service/src/shared/runtime/knowledge-connections';

const root = resolve(import.meta.dirname, '../..');
const requireFromTest = createRequire(import.meta.url);
const { Pool } = requireFromTest('../../packages/service/node_modules/pg') as {
  Pool: new (options: { connectionString: string }) => {
    query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      values?: unknown[],
    ): Promise<{ rows: T[] }>;
    end(): Promise<void>;
  };
};
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const workspaceId = `ws_b07_e2e_${suffix}`;
const memberId = `mem_b07_e2e_${suffix}`;
const authToken = `b07-e2e-${suffix}`;
const runId = process.env.B07_RUN_ID ?? '20261114-170200';
const resultDir = join(root, 'test-results', 'b07', runId, 'e2e');

interface ApiPayload<T> {
  success?: boolean;
  data?: T;
  error?: { code?: string; details?: Record<string, unknown> };
  traceId?: string;
  requestId?: string;
}

interface SourceFixture {
  id: string;
  blobId: string;
  name: string;
  body: Buffer;
}

interface JobView {
  jobId: string;
  kind: string;
  status: string;
  result: {
    objectBlobRefId?: string;
    diffCount?: number;
    repairedCount?: number;
    items?: Array<Record<string, unknown>>;
  } | null;
}

let app: B06aAppHarness;
let browser: Browser;
let connection: Connection;
let cookie: Awaited<ReturnType<typeof consoleCookie>>;
let spaceId = '';
let objectStore: MinioKnowledgeObjectStore;
let pool: InstanceType<typeof Pool>;
const createdObjectKeys = new Set<string>();

function requestHeaders(idempotencyKey = `b07-${randomUUID()}`): Record<string, string> {
  return apiHeaders({ authToken, workspaceId, idempotencyKey });
}

async function request<T>(
  path: string,
  method: 'GET' | 'POST' | 'PUT',
  body?: unknown,
): Promise<{ status: number; payload: ApiPayload<T> }> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: {
      ...requestHeaders(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json().catch(() => ({}))) as ApiPayload<T>;
  return { status: response.status, payload };
}

async function api<T>(path: string, method: 'GET' | 'POST' | 'PUT', body?: unknown): Promise<T> {
  const response = await request<T>(path, method, body);
  if (!response.payload.success || response.status >= 400) {
    throw new Error(
      `${method} ${path} -> ${response.status} ${String(response.payload.error?.code ?? '')}`,
    );
  }
  return response.payload.data as T;
}

async function waitForJob(jobId: string, timeoutMs = 90_000): Promise<JobView> {
  const deadline = Date.now() + timeoutMs;
  let last: JobView | null = null;
  while (Date.now() < deadline) {
    last = await api<JobView>(`/v1/knowledge/jobs/${jobId}`, 'GET');
    if (['succeeded', 'failed', 'cancelled', 'dead_letter'].includes(last.status)) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`job timeout: ${jobId} ${JSON.stringify(last)}`);
}

async function bindModels(): Promise<void> {
  const catalog = await api<{
    items: Array<{
      modelId: string;
      displayName: string;
      type: 'llm' | 'embedding' | 'rerank' | 'vlm' | 'stt' | 'tts';
      capabilities: string[];
      authorized: boolean;
    }>;
  }>('/v1/knowledge/models?limit=200', 'GET');
  const selected = catalog.items
    .filter((model) => model.authorized && ['llm', 'embedding', 'rerank'].includes(model.type))
    .filter(
      (model, index, rows) =>
        rows.findIndex((candidate) => candidate.type === model.type) === index,
    );
  const space = await api<{ version: number }>(`/v1/knowledge/spaces/${spaceId}`, 'GET');
  await api(`/v1/knowledge/spaces/${spaceId}/model-bindings`, 'PUT', {
    bindings: selected.map((model) => ({
      modelType: model.type,
      modelId: model.modelId,
      displayName: model.displayName,
      requiredCapabilities: model.capabilities,
      status: 'active',
    })),
    version: space.version,
  });
}

async function uploadSource(name: string, text: string): Promise<SourceFixture> {
  const body = Buffer.from(text);
  const session = await api<{ uploadId: string }>('/v1/knowledge/uploads', 'POST', {
    knowledgeSpaceId: spaceId,
    name,
    mimeType: 'text/plain',
    sizeBytes: body.byteLength,
  });
  const presigned = await api<{
    uploads: Array<{ url: string; headers: Record<string, string> }>;
  }>(`/v1/knowledge/uploads/${session.uploadId}/presign`, 'POST', { partNumbers: [1] });
  const uploaded = await fetch(presigned.uploads[0]!.url, {
    method: 'PUT',
    headers: presigned.uploads[0]!.headers,
    body,
  });
  expect(uploaded.status).toBe(200);
  const completed = await api<{ blobId: string }>(
    `/v1/knowledge/uploads/${session.uploadId}/complete`,
    'POST',
    { parts: [] },
  );
  const source = await connection.models.KnowledgeSource.create({
    workspaceId,
    knowledgeSpaceId: new connection.base.Types.ObjectId(spaceId),
    version: 1,
    deletedAt: null,
    createdByMemberId: memberId,
    updatedByMemberId: memberId,
    kind: 'file',
    name,
    blobRefId: new connection.base.Types.ObjectId(completed.blobId),
    mimeType: 'text/plain',
    sizeBytes: body.byteLength,
    ownershipMemberId: memberId,
  });
  const updated = await connection.models.KnowledgeObjectRef.updateOne(
    {
      workspaceId,
      _id: new connection.base.Types.ObjectId(completed.blobId),
    },
    { $set: { sourceId: source._id } },
  );
  expect(updated.modifiedCount).toBe(1);
  const ref = await connection.models.KnowledgeObjectRef.findOne({
    workspaceId,
    _id: new connection.base.Types.ObjectId(completed.blobId),
  }).lean();
  if (ref && typeof ref.objectKey === 'string') createdObjectKeys.add(ref.objectKey);
  return { id: String(source._id), blobId: completed.blobId, name, body };
}

async function archiveSources(sourceIds: string[]): Promise<JobView> {
  const queued = await request<JobView>(`/v1/knowledge/spaces/${spaceId}/source-archives`, 'POST', {
    sourceIds,
  });
  expect(queued.status, JSON.stringify(queued.payload)).toBe(202);
  expect(queued.payload.data?.jobId).toBeTypeOf('string');
  return waitForJob(queued.payload.data!.jobId);
}

async function pageFor(viewport = { width: 1440, height: 900 }): Promise<{
  context: Awaited<ReturnType<Browser['newContext']>>;
  page: Page;
}> {
  const context = await browser.newContext({ viewport, locale: 'zh-CN' });
  await context.addCookies([cookie]);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  return { context, page };
}

function storageContext(knowledgeSpaceId = spaceId) {
  return {
    workspaceId,
    knowledgeSpaceId,
    requestId: `req-b07-${suffix}`,
    traceId: suffix.padEnd(32, '0').slice(0, 32),
  };
}

function inspectZip(path: string): {
  names: string[];
  hashes: Record<string, string>;
  manifest: { entries: Array<{ sourceId: string; name: string }> };
} {
  const output = execFileSync('python3', [
    '-c',
    [
      'import hashlib, json, sys, zipfile',
      'archive = zipfile.ZipFile(sys.argv[1])',
      'names = archive.namelist()',
      'manifest = json.loads(archive.read("manifest.json").decode("utf-8"))',
      'hashes = {name: hashlib.sha256(archive.read(name)).hexdigest() for name in names if not name.endswith("/")}',
      'print(json.dumps({"names": names, "manifest": manifest, "hashes": hashes}))',
    ].join('\n'),
    path,
  ]).toString('utf8');
  return JSON.parse(output) as {
    names: string[];
    hashes: Record<string, string>;
    manifest: { entries: Array<{ sourceId: string; name: string }> };
  };
}

async function writeResourceSnapshot(phase: string): Promise<void> {
  if (!connection || !objectStore || !pool) return;
  const models = registerKnowledgeModels(connection);
  const names = [
    'KnowledgeSpace',
    'KnowledgeSource',
    'KnowledgeObjectRef',
    'KnowledgeJob',
    'KnowledgeJobStep',
    'KnowledgeAuditEvent',
    'KnowledgeOutboxEvent',
  ] as const;
  const mongo: Record<string, number> = {};
  for (const name of names) {
    const model = models[name];
    mongo[name] = model ? await model.countDocuments({ workspaceId }).catch(() => -1) : -1;
  }
  const pg: Record<string, number> = {};
  for (const table of [
    'knowledge_segment_vectors_768',
    'knowledge_segment_vectors_1024',
    'knowledge_segment_vectors_1536',
    'knowledge_segment_vectors_3072',
  ]) {
    const result = await pool
      .query<{
        count: string;
      }>(`SELECT count(*)::text AS count FROM ${table} WHERE workspace_id = $1`, [workspaceId])
      .catch(() => ({ rows: [{ count: '-1' }] }));
    pg[table] = Number(result.rows[0]?.count ?? -1);
  }
  const refs = await models.KnowledgeObjectRef.find({ workspaceId })
    .lean()
    .catch(() => []);
  const keys = new Map<string, string>();
  for (const ref of refs) keys.set(ref.objectKey, String(ref.knowledgeSpaceId));
  for (const key of createdObjectKeys) {
    if (!keys.has(key)) keys.set(key, spaceId);
  }
  let presentObjects = 0;
  const objectHashes: string[] = [];
  for (const [key, refSpaceId] of keys) {
    objectHashes.push(createHash('sha256').update(key).digest('hex').slice(0, 16));
    await objectStore
      .headObject(process.env.KB_TEST_S3_BUCKET, key, storageContext(refSpaceId))
      .then(() => {
        presentObjects += 1;
      })
      .catch(() => undefined);
  }
  await writeFile(
    join(resultDir, `resource-snapshot-${phase}.json`),
    `${JSON.stringify(
      {
        phase,
        workspaceIdHash: createHash('sha256').update(workspaceId).digest('hex').slice(0, 16),
        mongo,
        pgvector: pg,
        minio: {
          referencedOrFixtureKeys: keys.size,
          presentObjects,
          objectKeyHashes: objectHashes.sort(),
        },
        residualOrphans: null,
      },
      null,
      2,
    )}\n`,
  );
}

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_b07_e2e?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-test';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';

  app = await startB06aApp({ suffix, workspaceId, memberId, authToken, withWorker: true });
  cookie = await consoleCookie({ baseUrl: app.baseUrl, authToken, workspaceId });
  connection = await createKnowledgeMongoConnection(process.env.KB_TEST_MONGO_URI);
  registerKnowledgeModels(connection);
  spaceId = await createSpace({ baseUrl: app.baseUrl, authToken, workspaceId, suffix });
  await bindModels();
  browser = await chromium.launch({ headless: true });
  await mkdir(resultDir, { recursive: true });

  const endpoint = new URL(process.env.KB_TEST_S3_ENDPOINT);
  objectStore = new MinioKnowledgeObjectStore({
    provider: 'minio',
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || 80),
    useSSL: endpoint.protocol === 'https:',
    accessKey: process.env.KB_TEST_S3_ACCESS_KEY,
    secretKey: process.env.KB_TEST_S3_SECRET_KEY,
    region: process.env.KB_TEST_S3_REGION,
    bucket: process.env.KB_TEST_S3_BUCKET,
  });
  pool = new Pool({ connectionString: process.env.KB_TEST_PG_URL });
  await writeResourceSnapshot('before');
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await app?.close();
  await writeResourceSnapshot('before-cleanup');
  if (objectStore) {
    for (const key of createdObjectKeys) {
      await objectStore.deleteObject(key, storageContext()).catch(() => undefined);
    }
  }
  if (connection) {
    const models = registerKnowledgeModels(connection);
    if (objectStore) {
      const refs = await models.KnowledgeObjectRef.find({ workspaceId })
        .lean()
        .catch(() => []);
      for (const ref of refs) {
        await objectStore
          .deleteObject(ref.objectKey, storageContext(String(ref.knowledgeSpaceId)))
          .catch(() => undefined);
      }
    }
    for (const registration of KNOWLEDGE_SCHEMA_REGISTRY) {
      const model = models[registration.modelName];
      if (model) await model.deleteMany({ workspaceId });
    }
  }
  if (pool) {
    for (const table of [
      'knowledge_segment_vectors_768',
      'knowledge_segment_vectors_1024',
      'knowledge_segment_vectors_1536',
      'knowledge_segment_vectors_3072',
    ]) {
      await pool
        .query(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId])
        .catch(() => undefined);
    }
  }
  await writeResourceSnapshot('after-cleanup');
  if (connection) await connection.close();
  if (pool) await pool.end();
}, 60_000);

describe('L1-B07 OPS-004 archive lifecycle reconciliation', () => {
  it('L1-B07-OPS-004-P02 detects and repairs a real orphan vector', async () => {
    const vectorId = randomUUID();
    const embedding = `[1,${Array.from({ length: 767 }, () => 0).join(',')}]`;
    await pool.query(
      `INSERT INTO knowledge_segment_vectors_768
         (id, workspace_id, knowledge_space_id, source_id, segment_id, index_id,
          embedding_model_id, embedding, norm, content_hash, version, created_at, updated_at)
       VALUES
         ($1::uuid, $2, $3, $4, $5, $6, $7, $8::vector, 1, $9, 1,
          now() - interval '60 days', now() - interval '60 days')`,
      [
        vectorId,
        workspaceId,
        spaceId,
        new connection.base.Types.ObjectId().toString(),
        new connection.base.Types.ObjectId().toString(),
        new connection.base.Types.ObjectId().toString(),
        'mock-embedding-768',
        embedding,
        'a'.repeat(64),
      ],
    );

    const reconcile = await request<JobView>('/v1/knowledge/operations/reconcile', 'POST', {
      scope: 'vectors',
      repair: true,
    });
    expect(reconcile.status, JSON.stringify(reconcile.payload)).toBe(202);
    const reconcileJob = await waitForJob(reconcile.payload.data!.jobId);
    expect(reconcileJob.status).toBe('succeeded');
    expect(reconcileJob.result?.items?.find((item) => item.scope === 'vectors')).toMatchObject({
      active: 0,
      stored: 1,
      orphan: 1,
    });
    const remaining = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM knowledge_segment_vectors_768
        WHERE workspace_id = $1 AND id = $2::uuid`,
      [workspaceId, vectorId],
    );
    expect(remaining.rows[0]?.count).toBe('0');
  }, 180_000);

  it('L1-B07-OPS-004-P01 scans a real physical bucket orphan and preserves active objects', async () => {
    const active = await uploadSource(`active-${suffix}.txt`, 'active source body');
    const orphanId = new connection.base.Types.ObjectId().toString();
    const orphanKey = knowledgeObjectKey({
      workspaceId,
      knowledgeSpaceId: spaceId,
      sourceId: new connection.base.Types.ObjectId().toString(),
      purpose: 'export',
      blobId: orphanId,
      safeName: 'physical-orphan.bin',
    });
    await objectStore.putObject(
      {
        key: orphanKey,
        body: Buffer.from('physical orphan without a Mongo object ref'),
        contentType: 'application/octet-stream',
        workspaceId,
        knowledgeSpaceId: spaceId,
      },
      storageContext(),
    );
    createdObjectKeys.add(orphanKey);

    const activeRef = await connection.models.KnowledgeObjectRef.findOne({
      workspaceId,
      _id: new connection.base.Types.ObjectId(active.blobId),
    }).lean();
    expect(activeRef).not.toBeNull();
    const activeHead = await objectStore.headObject(
      activeRef!.bucket,
      activeRef!.objectKey,
      storageContext(),
    );
    expect(activeHead.size).toBe(active.body.byteLength);

    const cleanup = await request<JobView>('/v1/knowledge/operations/cleanup', 'POST', {
      scope: 'orphan_objects',
    });
    expect(cleanup.status, JSON.stringify(cleanup.payload)).toBe(202);
    const cleanupJob = await waitForJob(cleanup.payload.data!.jobId);
    expect(cleanupJob.status).toBe('succeeded');

    const reconcile = await request<JobView>('/v1/knowledge/operations/reconcile', 'POST', {
      scope: 'objects',
      repair: true,
    });
    expect(reconcile.status, JSON.stringify(reconcile.payload)).toBe(202);
    const reconcileJob = await waitForJob(reconcile.payload.data!.jobId);
    expect(reconcileJob.status).toBe('succeeded');
    const objectResult = reconcileJob.result?.items?.find((item) => item.scope === 'objects');
    await writeFile(
      join(resultDir, 'ops-object-reconcile.json'),
      `${JSON.stringify(
        {
          cleanupJobId: cleanupJob.jobId,
          cleanupTraceId: cleanup.payload.traceId,
          cleanupRequestId: cleanup.payload.requestId,
          cleanupResult: cleanupJob.result,
          reconcileJobId: reconcileJob.jobId,
          reconcileTraceId: reconcile.payload.traceId,
          reconcileRequestId: reconcile.payload.requestId,
          reconcileResult: reconcileJob.result,
          expected: { scanned: 2, missing: 1 },
          actual: objectResult,
        },
        null,
        2,
      )}\n`,
    );
    expect(objectResult).toMatchObject({
      scanned: 2,
      missing: 1,
    });

    await expect(
      objectStore.headObject(process.env.KB_TEST_S3_BUCKET, orphanKey, storageContext()),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    const preserved = await objectStore.headObject(
      activeRef!.bucket,
      activeRef!.objectKey,
      storageContext(),
    );
    expect(preserved.size).toBe(active.body.byteLength);
  }, 180_000);

  it('L1-B07-FILE-004-P01/S01 mirrors a real archive Job and preserves the source object', async () => {
    const first = await uploadSource(`archive-first-${suffix}.txt`, `first archive body ${suffix}`);
    const second = await uploadSource(
      `archive-second-${suffix}.txt`,
      `second archive body ${suffix}`,
    );
    const sourceBefore = await connection.models.KnowledgeSource.findOne({
      workspaceId,
      _id: new connection.base.Types.ObjectId(first.id),
    }).lean();
    const job = await archiveSources([first.id, second.id]);
    expect(job.status).toBe('succeeded');
    const blobId = job.result?.objectBlobRefId;
    expect(blobId).toBeTypeOf('string');

    const artifact = await connection.models.KnowledgeObjectRef.findOne({
      workspaceId,
      _id: new connection.base.Types.ObjectId(blobId!),
    }).lean();
    expect(artifact).toMatchObject({
      purpose: 'export',
      state: 'active',
      mimeType: 'application/zip',
    });
    expect(Date.parse(String(artifact!.expiresAt))).toBeGreaterThan(Date.now());
    const sourceAfter = await connection.models.KnowledgeSource.findOne({
      workspaceId,
      _id: new connection.base.Types.ObjectId(first.id),
    }).lean();
    expect(sourceAfter!.version).toBe(sourceBefore!.version);
    expect(String(sourceAfter!.blobRefId)).toBe(String(sourceBefore!.blobRefId));

    const ticket = await api<{ url: string; expiresAt: string; disposition: string }>(
      `/v1/knowledge/files/${blobId}/download`,
      'POST',
      { ttlSeconds: 300 },
    );
    expect(ticket.disposition).toBe('attachment');
    expect(Date.parse(ticket.expiresAt)).toBeGreaterThan(Date.now());

    const { context, page } = await pageFor();
    try {
      await page.goto(`${app.baseUrl}/dataset/detail?datasetId=${spaceId}`, {
        waitUntil: 'networkidle',
      });
      const downloaded = page.waitForEvent('download', { timeout: 30_000 });
      await page.evaluate((url) => {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'b07-archive.zip';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }, ticket.url);
      const download = await downloaded;
      const zipPath = join(resultDir, 'b07-archive.zip');
      await download.saveAs(zipPath);
      const { manifest, names, hashes } = inspectZip(zipPath);
      expect(manifest.entries.map((entry) => entry.sourceId).sort()).toEqual(
        [first.id, second.id].sort(),
      );
      expect(manifest.entries.map((entry) => entry.name).sort()).toEqual(
        [first.name, second.name].sort(),
      );
      expect(names).toContain('manifest.json');
      expect(names.some((name) => name.endsWith('/' + first.name))).toBe(true);
      expect(names.some((name) => name.endsWith('/' + second.name))).toBe(true);
      const firstEntry = manifest.entries.find((entry) => entry.sourceId === first.id);
      const firstPath = names.find((name) => name.endsWith('/' + firstEntry!.name));
      expect(firstPath).toBeTypeOf('string');
      expect(hashes[firstPath!]).toBe(createHash('sha256').update(first.body).digest('hex'));
      await page.screenshot({ path: join(resultDir, 'archive-download-page.png') });
    } finally {
      await context.close();
    }
  }, 180_000);

  it('L1-B07-OPS-004-S01 repair does not delete an existing export ObjectRef', async () => {
    const source = await uploadSource(`repair-export-${suffix}.txt`, 'repair must keep export');
    const job = await archiveSources([source.id]);
    const blobId = job.result?.objectBlobRefId;
    expect(blobId).toBeTypeOf('string');
    const artifact = await connection.models.KnowledgeObjectRef.findOne({
      workspaceId,
      _id: new connection.base.Types.ObjectId(blobId!),
    }).lean();
    expect(artifact?.state).toBe('active');
    const headBefore = await objectStore.headObject(
      artifact!.bucket,
      artifact!.objectKey,
      storageContext(),
    );
    expect(headBefore.size).toBeGreaterThan(0);

    const reconcile = await request<JobView>('/v1/knowledge/operations/reconcile', 'POST', {
      scope: 'objects',
      repair: true,
    });
    expect(reconcile.status, JSON.stringify(reconcile.payload)).toBe(202);
    const reconcileJob = await waitForJob(reconcile.payload.data!.jobId);
    expect(reconcileJob.status).toBe('succeeded');
    const artifactAfter = await connection.models.KnowledgeObjectRef.findOne({
      workspaceId,
      _id: new connection.base.Types.ObjectId(blobId!),
    }).lean();
    await writeFile(
      join(resultDir, 'ops-export-preservation.json'),
      `${JSON.stringify(
        {
          jobId: reconcileJob.jobId,
          traceId: reconcile.payload.traceId,
          requestId: reconcile.payload.requestId,
          blobId,
          physicalObjectSize: headBefore.size,
          stateBefore: artifact?.state,
          stateAfter: artifactAfter?.state,
          reconcileResult: reconcileJob.result,
        },
        null,
        2,
      )}\n`,
    );
    expect(artifactAfter?.state).toBe('active');
    const headAfter = await objectStore.headObject(
      artifact!.bucket,
      artifact!.objectKey,
      storageContext(),
    );
    expect(headAfter.size).toBe(headBefore.size);
  }, 180_000);

  it('L1-B07-FILE-004-C01 consumes an archive ticket at most once', async () => {
    const source = await uploadSource(`ticket-once-${suffix}.txt`, 'ticket is single use');
    const job = await archiveSources([source.id]);
    const blobId = job.result?.objectBlobRefId;
    expect(blobId).toBeTypeOf('string');
    const ticketResponse = await request<{ url: string; expiresAt: string }>(
      `/v1/knowledge/files/${blobId}/download`,
      'POST',
      { ttlSeconds: 300 },
    );
    expect(ticketResponse.status).toBe(200);
    expect(ticketResponse.payload.success).toBe(true);
    const ticket = ticketResponse.payload.data!;
    const cookieHeader = `${cookie.name}=${cookie.value}`;
    const first = await fetch(ticket.url, { headers: { cookie: cookieHeader } });
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    const second = await fetch(ticket.url, { headers: { cookie: cookieHeader } });
    await writeFile(
      join(resultDir, 'ticket-reuse-status.json'),
      `${JSON.stringify(
        {
          first: first.status,
          second: second.status,
          expiresAt: ticket.expiresAt,
          traceId: ticketResponse.payload.traceId,
          requestId: ticketResponse.payload.requestId,
        },
        null,
        2,
      )}\n`,
    );
    expect(second.status).toBe(403);
  }, 180_000);

  it('L1-B07-FILE-004-UI01 downloads the selected Sources without leaving the list', async () => {
    const first = await uploadSource(`ui-archive-a-${suffix}.txt`, 'ui archive a');
    const second = await uploadSource(`ui-archive-b-${suffix}.txt`, 'ui archive b');
    const { context, page } = await pageFor();
    try {
      const archiveResponses: Array<Record<string, unknown>> = [];
      page.on('response', (response) => {
        if (!response.url().includes('/source-archives')) return;
        void response
          .json()
          .then((body) => archiveResponses.push({ status: response.status(), body }))
          .catch(() => undefined);
      });
      await page.goto(`${app.baseUrl}/dataset/detail?datasetId=${spaceId}`, {
        waitUntil: 'networkidle',
      });
      await page.getByRole('button', { name: '批量管理' }).click();
      await page.getByRole('checkbox', { name: `选择 ${first.name}` }).check();
      await page.getByRole('checkbox', { name: `选择 ${second.name}` }).check();
      expect(await page.getByRole('region', { name: 'Collection 批量操作' }).isVisible()).toBe(
        true,
      );
      await page.screenshot({ path: join(resultDir, 'archive-ui-selected.png') });
      const downloadPromise = page.waitForEvent('download', { timeout: 8_000 });
      await page.getByRole('button', { name: '批量下载' }).click();
      await page.waitForTimeout(2_000);
      await page.screenshot({ path: join(resultDir, 'archive-ui-after-click.png') });
      await writeFile(
        join(resultDir, 'archive-ui-network.json'),
        `${JSON.stringify(
          {
            pagePath: new URL(page.url()).pathname,
            selectedSourceIds: [first.id, second.id],
            archiveResponses,
            downloadObserved: false,
          },
          null,
          2,
        )}\n`,
      );
      await expect(downloadPromise).resolves.toBeTruthy();
      expect(new URL(page.url()).pathname).toBe('/dataset/detail');
      await page.screenshot({ path: join(resultDir, 'archive-ui-download.png') });
    } finally {
      await context.close();
    }
  }, 180_000);
});
