import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiRequest,
  cleanupWorkspaceObjects,
  createApiKey,
  createSpace,
  openConnections,
  redact,
  spawnConsumer,
  startB18App,
  suffix as uniqueSuffix,
  writeJson,
  type B18AppHarness,
  type ConsumerJob,
} from '../fixtures/b18-b/support';
import { registerKnowledgeModels, type KnowledgeConnections } from '../../packages/service/src';

const root = resolve(import.meta.dirname, '../..');
const runId = process.env.B18_RUN_ID?.trim() || `import-${Date.now()}`;
const evidenceDir = join(root, 'test-results', 'b18-b', runId);
const suffix = uniqueSuffix('import');
const workspaceId = `ws_${suffix}`;
const memberId = `mem_${suffix}`;
const adminToken = `b18b-import-auth-${suffix}`;
const secrets: string[] = [];

let app: B18AppHarness;
let connections: KnowledgeConnections;
let spaceA = '';
let spaceB = '';
let writeKey = '';
let readKey = '';

async function bindModels(spaceId: string): Promise<void> {
  const catalog = await apiRequest<{
    items: Array<{
      modelId: string;
      displayName: string;
      type: 'llm' | 'embedding' | 'rerank' | 'vlm' | 'stt' | 'tts';
      capabilities: string[];
      authorized: boolean;
    }>;
  }>(app, '/v1/knowledge/models?limit=200', {
    workspaceId,
    token: adminToken,
  });
  expect(catalog.response.status).toBe(200);
  const selected = catalog.payload
    .data!.items.filter(
      (model) => model.authorized && ['llm', 'embedding', 'rerank'].includes(model.type),
    )
    .filter(
      (model, index, rows) =>
        rows.findIndex((candidate) => candidate.type === model.type) === index,
    );
  const space = await apiRequest<{ version: number }>(app, `/v1/knowledge/spaces/${spaceId}`, {
    workspaceId,
    token: adminToken,
  });
  expect(space.response.status).toBe(200);
  const bound = await apiRequest(app, `/v1/knowledge/spaces/${spaceId}/model-bindings`, {
    method: 'PUT',
    workspaceId,
    token: adminToken,
    idempotencyKey: `b18b-bind-${suffix}-${spaceId}`,
    body: {
      bindings: selected.map((model) => ({
        modelType: model.type,
        modelId: model.modelId,
        displayName: model.displayName,
        requiredCapabilities: model.capabilities,
        status: 'active',
      })),
      version: space.payload.data!.version,
    },
  });
  expect(bound.response.status, bound.text).toBe(200);
}

async function requestImport(input: {
  token: string;
  key: string;
  body: unknown;
  workspace?: string;
}) {
  return apiRequest(app, `/v1/knowledge/spaces/${spaceA}/imports/text`, {
    method: 'POST',
    workspaceId: input.workspace ?? workspaceId,
    token: input.token,
    idempotencyKey: input.key,
    body: input.body,
  });
}

beforeAll(async () => {
  process.env.KB_TEST_MONGO_URI ??= 'mongodb://127.0.0.1:27017/kb_b18b_import?replicaSet=rs0';
  process.env.KB_TEST_REDIS_URL ??= 'redis://127.0.0.1:6379/0';
  process.env.KB_TEST_PG_URL ??= 'postgresql://kb:kb_dev_password@127.0.0.1:5432/kb';
  process.env.KB_TEST_S3_ENDPOINT ??= 'http://127.0.0.1:9000';
  process.env.KB_TEST_S3_REGION ??= 'us-east-1';
  process.env.KB_TEST_S3_BUCKET ??= 'kb-test';
  process.env.KB_TEST_S3_ACCESS_KEY ??= 'minioadmin';
  process.env.KB_TEST_S3_SECRET_KEY ??= 'minioadmin';

  app = await startB18App({
    suffix,
    workspaceId,
    memberId,
    authToken: adminToken,
    withWorker: true,
  });
  connections = await openConnections();
  const createdA = await createSpace(app, {
    adminToken,
    workspaceId,
    suffix: `${suffix}-a`,
  });
  const createdB = await createSpace(app, {
    adminToken,
    workspaceId,
    suffix: `${suffix}-b`,
  });
  spaceA = createdA.id;
  spaceB = createdB.id;
  await bindModels(spaceA);
  await bindModels(spaceB);
  const write = await createApiKey(app, {
    adminToken,
    workspaceId,
    suffix: `${suffix}-write`,
    scopes: ['knowledge:read', 'knowledge:write'],
    spaceIds: [spaceA],
  });
  const read = await createApiKey(app, {
    adminToken,
    workspaceId,
    suffix: `${suffix}-read`,
    scopes: ['knowledge:read'],
    spaceIds: [spaceA],
  });
  writeKey = write.secret;
  readKey = read.secret;
  secrets.push(writeKey, readKey);
}, 300_000);

afterAll(async () => {
  const objectCleanup = connections
    ? await cleanupWorkspaceObjects(connections, workspaceId)
    : { refs: 0, deleted: 0, failed: 0 };
  if (app) {
    writeJson(join(evidenceDir, 'import-app-output.json'), {
      runId,
      workspaceId,
      output: redact(app.output(), secrets),
      providerMode: 'BLOCKED_PROVIDER',
      objectCleanup,
    });
  }
  if (connections) {
    const models = registerKnowledgeModels(connections.mongo);
    for (const model of Object.values(models)) {
      await model.deleteMany({ workspaceId });
    }
    for (const table of [
      'knowledge_segment_vectors_768',
      'knowledge_segment_vectors_1024',
      'knowledge_segment_vectors_1536',
      'knowledge_segment_vectors_3072',
    ]) {
      await connections.pg.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId]);
    }
    await connections.close();
  }
  await app?.close();
}, 120_000);

describe('L1-B18-B DOWN-004 external import consumer', () => {
  it('DOWN-004-P01/N01/S01 completes a real text import and exact idempotent replay', async () => {
    const body = {
      knowledgeSpaceId: spaceA,
      directoryId: null,
      name: `B18B external import ${suffix}`,
      text: 'External consumer import body for DOWN-004.',
      chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
    };
    const requestId = `b18b-import-${suffix}-primary`;
    const first = await spawnConsumer(
      {
        role: 'import',
        baseUrl: app.baseUrl,
        workspaceId,
        requestId,
        query: '',
        knowledgeSpaceId: spaceA,
        tokenBudget: 5_000,
        importBody: body,
      } satisfies ConsumerJob,
      writeKey,
      180_000,
    );
    writeJson(join(evidenceDir, 'primary-import-consumer.json'), first);
    expect(first).toMatchObject({ ok: true, acceptedStatus: 202, stopReason: 'succeeded' });
    const job = first.job as { jobId: string };
    expect(job.jobId).toBeTruthy();

    const replay = await requestImport({ token: writeKey, key: requestId, body });
    expect(replay.response.status).toBe(202);
    expect(replay.payload.data).toMatchObject({ jobId: job.jobId });

    const sources = await apiRequest<{
      items: Array<{ id: string; name: string; sourceVersion: number }>;
    }>(app, `/v1/knowledge/spaces/${spaceA}/sources?limit=100`, {
      workspaceId,
      token: writeKey,
    });
    expect(sources.response.status).toBe(200);
    const source = sources.payload.data?.items.find((item) => item.name === body.name);
    expect(source).toBeTruthy();
    const segments = await apiRequest<{
      items: Array<{ content: string; sourceVersion: number }>;
    }>(app, `/v1/knowledge/sources/${source!.id}/segments?limit=100`, {
      workspaceId,
      token: writeKey,
    });
    expect(segments.response.status).toBe(200);
    expect(segments.payload.data!.items.length).toBeGreaterThan(0);
    expect(segments.payload.data!.items.map((item) => item.content).join('')).toContain(
      'External consumer import body',
    );
    const preview = await apiRequest<{
      sections: Array<{ text: string }>;
    }>(app, `/v1/knowledge/sources/${source!.id}/preview`, {
      workspaceId,
      token: writeKey,
    });
    expect(preview.response.status).toBe(200);
    expect(preview.payload.data!.sections.map((section) => section.text).join('\n')).toContain(
      'External consumer import body',
    );
    const models = registerKnowledgeModels(connections.mongo);
    const sourceDocument = await models.KnowledgeSource.findOne({
      workspaceId,
      _id: source!.id,
      deletedAt: null,
    }).lean();
    const jobDocument = await models.KnowledgeJob.findOne({
      workspaceId,
      _id: job.jobId,
    }).lean();
    expect(sourceDocument).toBeTruthy();
    expect(jobDocument).toMatchObject({ status: 'succeeded', kind: 'import' });
    const [usageCount, auditCount, outboxCount] = await Promise.all([
      models.KnowledgeUsageEvent.countDocuments({
        workspaceId,
        $or: [
          { resourceId: sourceDocument!._id },
          { jobId: jobDocument!._id },
          { resourceId: jobDocument!._id },
        ],
      }),
      models.KnowledgeAuditEvent.countDocuments({
        workspaceId,
        $or: [
          { resourceId: source!.id },
          { resourceId: job.jobId },
          { requestId: first.requestId },
          { traceId: first.traceId },
        ],
      }),
      models.KnowledgeOutboxEvent.countDocuments({
        workspaceId,
        aggregateId: job.jobId,
      }),
    ]);
    writeJson(join(evidenceDir, 'primary-import-lineage.json'), {
      sourceId: source!.id,
      jobId: job.jobId,
      sourceVersion: sourceDocument!.sourceVersion,
      jobStatus: jobDocument!.status,
      rawTextHash: sourceDocument!.contentHash,
      segmentCount: segments.payload.data!.items.length,
      usageCount,
      auditCount,
      outboxCount,
    });
    expect(usageCount).toBeGreaterThan(0);
    expect(auditCount).toBeGreaterThan(0);
    expect(outboxCount).toBeGreaterThan(0);
    expect(JSON.stringify({ first, replay: replay.payload })).not.toMatch(
      /kn_live_|objectKey|authorization|secretHash/i,
    );
  }, 240_000);

  it('DOWN-004-N01 rejects same key/different body and invalid input without side effects', async () => {
    const key = `b18b-import-${suffix}-conflict`;
    const baseBody = {
      knowledgeSpaceId: spaceA,
      directoryId: null,
      name: `B18B conflict ${suffix}`,
      text: 'Conflict body first.',
      chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
    };
    const first = await requestImport({ token: writeKey, key, body: baseBody });
    expect(first.response.status).toBe(202);
    const conflict = await requestImport({
      token: writeKey,
      key,
      body: { ...baseBody, text: 'Conflict body second.' },
    });
    expect(conflict.response.status).toBe(409);
    expect(conflict.payload.error?.code).toBe('KNOWLEDGE_CONFLICT');

    const missing = await requestImport({
      token: writeKey,
      key: `b18b-import-${suffix}-missing`,
      body: { knowledgeSpaceId: spaceA, text: 'missing name' },
    });
    expect(missing.response.status).toBe(400);
    const invalidDirectory = await requestImport({
      token: writeKey,
      key: `b18b-import-${suffix}-directory`,
      body: {
        ...baseBody,
        directoryId: '65f1e5b2a1c9d4b7e8f09999',
        name: `B18B invalid directory ${suffix}`,
      },
    });
    expect([404, 400]).toContain(invalidDirectory.response.status);
  }, 120_000);

  it('DOWN-004-A01/Q01 enforces write scope, tenant and payload limits', async () => {
    const body = {
      knowledgeSpaceId: spaceA,
      directoryId: null,
      name: `B18B denied ${suffix}`,
      text: 'Denied body.',
      chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
    };
    const readDenied = await requestImport({
      token: readKey,
      key: `b18b-import-${suffix}-read-denied`,
      body,
    });
    expect(readDenied.response.status).toBe(403);
    const foreignDenied = await requestImport({
      token: writeKey,
      key: `b18b-import-${suffix}-foreign`,
      body,
      workspace: `ws_foreign_${suffix}`,
    });
    expect([401, 403]).toContain(foreignDenied.response.status);
    const oversized = await requestImport({
      token: writeKey,
      key: `b18b-import-${suffix}-oversized`,
      body: { ...body, text: 'x'.repeat(10_000_001), name: `B18B oversized ${suffix}` },
    });
    writeJson(join(evidenceDir, 'oversized-import-response.json'), {
      status: oversized.response.status,
      problem: oversized.payload.error,
    });
    expect([400, 413]).toContain(oversized.response.status);
    if (oversized.response.status === 400) {
      expect(['KNOWLEDGE_PAYLOAD_TOO_LARGE', 'KNOWLEDGE_VALIDATION_FAILED']).toContain(
        oversized.payload.error?.code,
      );
    }
  }, 180_000);

  it('DOWN-004-C01 serializes one business object for concurrent identical keys', async () => {
    const key = `b18b-import-${suffix}-concurrent`;
    const body = {
      knowledgeSpaceId: spaceA,
      directoryId: null,
      name: `B18B concurrent import ${suffix}`,
      text: 'Concurrent identical import body.',
      chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => requestImport({ token: writeKey, key, body })),
    );
    const succeeded = results.filter((result) => result.response.status === 202);
    expect(succeeded.length).toBeGreaterThan(0);
    const jobIds = new Set(
      succeeded.map((result) => (result.payload.data as { jobId?: string }).jobId),
    );
    expect(jobIds.size).toBe(1);
    const sources = await apiRequest<{ items: Array<{ name: string }> }>(
      app,
      `/v1/knowledge/spaces/${spaceA}/sources?limit=200`,
      { workspaceId, token: writeKey },
    );
    expect(sources.payload.data!.items.filter((item) => item.name === body.name)).toHaveLength(1);
  }, 180_000);

  it('TEST-X-API-003 rate limits repeated invalid import requests', async () => {
    const responses = await Promise.all(
      Array.from({ length: 45 }, (_, index) =>
        requestImport({
          token: writeKey,
          key: `b18b-import-${suffix}-rate-${index}`,
          body: {},
        }),
      ),
    );
    const limited = responses.filter((result) => result.response.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    expect(limited.every((result) => result.payload.error?.code === 'KNOWLEDGE_RATE_LIMITED')).toBe(
      true,
    );
    expect(limited.every((result) => result.response.headers.get('retry-after'))).toBe(true);
  }, 120_000);
});
