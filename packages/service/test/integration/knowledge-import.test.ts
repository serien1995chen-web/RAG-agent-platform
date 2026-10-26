import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeImportRepository } from '../../src/modules/knowledge/repository/import.repository';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';
import type { ImportSubmissionCommand } from '../../src/modules/knowledge/application/ingestion.ports';
import { requestHashOf } from '../../src/modules/knowledge/domain/import-submission';
import {
  FixtureQuotaGatePort,
  FixtureScopedAuthPort,
  S04IngestionApplication,
  type S04IngestionDependencies,
} from '../../src/modules/knowledge/application/operations/s04-ingestion';
import { KnowledgeIngestionContentAdapter } from '../../src/modules/knowledge/adapter/ingestion-content';
import type { ObjectRefView } from '../../src/modules/knowledge/application/ports';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const workspaceId = `ws_s4_import_${suffix}`;
const context: TenantContext = {
  workspaceId,
  memberId: `mem_s4_${suffix}`,
  requestId: `req_s4_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
};

let connection: mongoose.Connection;
let repository: KnowledgeImportRepository;
let spaceId: string;
const objectBytes = new Map<string, Uint8Array>();
const uploadRefs = new Map<string, ObjectRefView>();

interface IngestionCounters {
  puts: string[];
  deletes: string[];
  reads: string[];
  urlFetches: number;
  customApiCatalog: number;
  customApiContent: number;
  providerCatalog: number;
  providerContent: number;
}

function newCounters(): IngestionCounters {
  return {
    puts: [],
    deletes: [],
    reads: [],
    urlFetches: 0,
    customApiCatalog: 0,
    customApiContent: 0,
    providerCatalog: 0,
    providerContent: 0,
  };
}

interface IngestionFixtureOptions {
  counters?: IngestionCounters;
  failMaterializeOn?: number;
  dependencies?: Partial<
    Pick<
      S04IngestionDependencies,
      | 'access'
      | 'connectors'
      | 'customApi'
      | 'providers'
      | 'quotaGate'
      | 'templateParser'
      | 'urlImport'
      | 'queuePort'
    >
  >;
}

function id(): string {
  return new mongoose.Types.ObjectId().toString();
}

function command(input?: {
  key?: string;
  body?: Record<string, unknown>;
  sourceCount?: number;
}): ImportSubmissionCommand {
  const count = input?.sourceCount ?? 1;
  const requestBody = input?.body ?? { uploadIds: ['one'] };
  return {
    workspaceId,
    knowledgeSpaceId: spaceId,
    directoryId: null,
    importKind: 'files',
    idempotencyKey: input?.key ?? `idem-${suffix}-0001`,
    requestHash: requestHashOf(requestBody),
    configurationHash: requestHashOf({ chunking: 'auto' }),
    sourceDrafts: Array.from({ length: count }, (_, index) => ({
      id: id(),
      kind: 'text' as const,
      name: `source-${index}.txt`,
      directoryId: null,
      blobRefId: null,
      externalId: null,
      connectorId: null,
      mimeType: 'text/plain',
      sizeBytes: 5,
      contentHash: 'hash',
      parseProvider: 'liteparse' as const,
      metadata: { index },
    })),
    parseConfigSnapshot: {},
    chunkingConfigSnapshot: { mode: 'auto' },
    qaConfigSnapshot: {},
  };
}

async function createSpace(): Promise<string> {
  registerKnowledgeModels(connection);
  const document = await connection.models.KnowledgeSpace.create({
    workspaceId,
    knowledgeSpaceId: null,
    version: 1,
    deletedAt: null,
    createdByMemberId: context.memberId,
    updatedByMemberId: context.memberId,
    kind: 'space',
    parentSpaceId: null,
    name: `Space ${randomUUID().slice(0, 8)}`,
    normalizedName: `space-${randomUUID()}`,
    description: '',
    iconKey: 'book-open',
    ownershipMemberId: context.memberId,
    accessMode: 'workspace',
    sourceAclMode: 'enforced',
    sourcePermissionEnabled: true,
    referenceRevision: 0,
    permissionRevision: 0,
    modelBindings: {},
    defaultChunking: {},
    status: 'active',
  });
  return String(document._id);
}

function uploadRef(uploadId: string, fileName: string, mimeType: string): ObjectRefView {
  const now = new Date().toISOString();
  return {
    blobId: uploadId,
    workspaceId,
    knowledgeSpaceId: spaceId,
    provider: 'minio',
    bucket: 'kb-test',
    objectKey: `uploads/${uploadId}/${fileName}`,
    providerUploadId: null,
    uploadMode: 'single',
    uploadStatus: 'completed',
    pendingObjectKey: null,
    finalObjectKey: `uploads/${uploadId}/${fileName}`,
    finalizedAt: now,
    pendingUrlExpiresAt: null,
    originalName: fileName,
    purpose: 'source',
    sourceId: null,
    mimeType,
    sizeBytes: objectBytes.get(uploadId)?.byteLength ?? 0,
    etag: 'etag',
    sha256: 'sha256',
    state: 'active',
    expiresAt: null,
    version: 2,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function ingestionApplication(
  rowMode: 'template' | 'backup' = 'template',
  options: IngestionFixtureOptions = {},
) {
  const counters = options.counters ?? newCounters();
  const objectStore = {
    provider: 'minio' as const,
    bucket: 'kb-test',
    async putObject(input: {
      key: string;
      body: Uint8Array;
      contentType: string;
      workspaceId: string;
      knowledgeSpaceId: string;
    }) {
      objectBytes.set(input.key, input.body);
      counters.puts.push(input.key);
      return {
        provider: 'minio' as const,
        bucket: 'kb-test',
        key: input.key,
        size: input.body.byteLength,
        etag: 'etag-created',
        sha256: requestHashOf(Array.from(input.body)),
      };
    },
    async getObject(_bucket: string, key: string) {
      counters.reads.push(key);
      const bytes = objectBytes.get(key) ?? new Uint8Array();
      return {
        body: (async function* () {
          yield bytes;
        })(),
        size: bytes.byteLength,
        etag: 'etag',
        contentType: null,
      };
    },
    async deleteObject(key: string) {
      counters.deletes.push(key);
      objectBytes.delete(key);
      return { deleted: true };
    },
  };
  const content = new KnowledgeIngestionContentAdapter(objectStore);
  if (options.failMaterializeOn !== undefined) {
    const original = content.materializeProviderContent.bind(content);
    let calls = 0;
    content.materializeProviderContent = async (input) => {
      calls += 1;
      if (calls === options.failMaterializeOn) {
        throw new Error('injected-materialization-failure');
      }
      return original(input);
    };
  }
  return new S04IngestionApplication({
    imports: repository,
    connectors: options.dependencies?.connectors ?? ({} as never),
    objectRefs: {
      async findObjectRef(id) {
        return uploadRefs.get(id) ?? null;
      },
    },
    content,
    urlImport: options.dependencies?.urlImport ?? {
      async fetch(input) {
        counters.urlFetches += 1;
        return {
          finalUrl: input.url,
          safeUrl: input.url,
          urlHash: requestHashOf(input.url),
          title: 'Fetched page',
          contentType: 'text/html',
          bytes: Buffer.from('<html><title>Fetched page</title></html>'),
        };
      },
    },
    customApi: options.dependencies?.customApi ?? {
      async catalog() {
        counters.customApiCatalog += 1;
        return {
          provider: 'custom' as const,
          items: [{ id: 'file:1', name: 'API Doc', type: 'document' as const }],
        };
      },
      async content(input) {
        counters.customApiContent += 1;
        return input.fileIds.map((externalId) => ({
          externalId,
          title: 'API Doc',
          mimeType: 'text/plain',
          bytes: Buffer.from('API content'),
        }));
      },
    },
    providers:
      options.dependencies?.providers ??
      ({
        feishu: {
          async catalog() {
            counters.providerCatalog += 1;
            return {
              provider: 'feishu' as const,
              items: [{ id: 'doc_fixture', name: 'Fixture', type: 'document' as const }],
            };
          },
          async content() {
            counters.providerContent += 1;
            return [
              {
                externalId: 'doc_fixture',
                title: 'Fixture',
                mimeType: 'text/plain',
                bytes: Buffer.from('fixture'),
              },
            ];
          },
        },
      } as never),
    access:
      options.dependencies?.access ??
      ({
        async assertPermission() {
          return undefined;
        },
      } as never),
    scopedAuth: new FixtureScopedAuthPort(),
    quotaGate: options.dependencies?.quotaGate ?? new FixtureQuotaGatePort(),
    templateParser: options.dependencies?.templateParser ?? {
      parse() {
        return {
          format: 'csv' as const,
          headers:
            rowMode === 'backup' ? ['q', 'a', 'index', 'metadata', 'schemaversion'] : ['q', 'a'],
          rows:
            rowMode === 'backup'
              ? [
                  {
                    rowNumber: 2,
                    question: 'Backup question',
                    answer: 'Backup answer',
                    indexes: [],
                    metadata: {},
                    schemaVersion: 1,
                  },
                ]
              : [
                  {
                    rowNumber: 2,
                    question: 'Template question',
                    answer: 'Template answer',
                    indexes: [],
                    metadata: {},
                    schemaVersion: 1,
                  },
                ],
          diagnostics: [],
        };
      },
    },
    ...(options.dependencies?.queuePort ? { queuePort: options.dependencies.queuePort } : {}),
  });
}

beforeAll(async () => {
  const uri = new URL(
    process.env.KB_TEST_MONGO_URI ??
      `mongodb://127.0.0.1:27017/kb_s4_import_${suffix}?replicaSet=rs0&directConnection=true`,
  );
  connection = mongoose.createConnection(uri.toString(), {
    serverSelectionTimeoutMS: 5_000,
  });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);
  repository = new KnowledgeImportRepository(connection);
}, 60_000);

beforeEach(async () => {
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  objectBytes.clear();
  uploadRefs.clear();
  spaceId = await createSpace();
});

afterAll(async () => {
  if (!connection) return;
  for (const model of Object.values(registerKnowledgeModels(connection))) {
    await model.deleteMany({ workspaceId });
  }
  await connection.close();
});

describe('TEST-ING-001-BLOCK C1 import submission', () => {
  it('writes one parent Job, N Sources, Audit and one pending Outbox in one transaction', async () => {
    const submission = await repository.submit(command({ sourceCount: 3 }), context);
    expect(submission.status).toBe('queued');
    expect(submission.sourceIds).toHaveLength(3);

    const jobs = await connection.models.KnowledgeJob.find({ workspaceId }).lean();
    const sources = await connection.models.KnowledgeSource.find({ workspaceId }).lean();
    const audits = await connection.models.KnowledgeAuditEvent.find({ workspaceId }).lean();
    const outbox = await connection.models.KnowledgeOutboxEvent.find({ workspaceId }).lean();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      kind: 'import',
      resourceType: 'space',
      status: 'queued',
    });
    expect(sources).toHaveLength(3);
    expect(sources.every((source) => source.processingStatus === 'queued')).toBe(true);
    expect(sources.every((source) => source.sourceVersion === 1 && source.version === 1)).toBe(
      true,
    );
    expect(audits).toHaveLength(1);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      eventType: 'import.submit',
      aggregateType: 'job',
      status: 'pending',
    });
    expect(await connection.models.KnowledgeJob.countDocuments({ kind: 'parse' })).toBe(0);
    expect(await connection.models.KnowledgeSegment.countDocuments({ workspaceId })).toBe(0);
  });

  it('TEST-DOWN-004-U03/U04 replays identical key/body and rejects a mismatched body', async () => {
    const first = command();
    const one = await repository.submit(first, context);
    const replay = await repository.submit(first, context);
    expect(replay.replayed).toBe(true);
    expect(replay.parentJobId).toBe(one.parentJobId);
    expect(replay.sourceIds).toEqual(one.sourceIds);

    await expect(
      repository.submit(
        command({ key: first.idempotencyKey, body: { uploadIds: ['two'] } }),
        context,
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
  });

  it('TEST-X-S4-COMMIT-FAULT rolls back Source/Job/Audit when Outbox creation fails', async () => {
    const failing = new KnowledgeImportRepository(connection, {
      beforeOutbox() {
        throw new Error('injected-outbox-failure');
      },
    });
    await expect(failing.submit(command({ key: `idem-${suffix}-fault` }), context)).rejects.toThrow(
      'injected-outbox-failure',
    );
    expect(await connection.models.KnowledgeSource.countDocuments({ workspaceId })).toBe(0);
    expect(await connection.models.KnowledgeJob.countDocuments({ workspaceId })).toBe(0);
    expect(await connection.models.KnowledgeAuditEvent.countDocuments({ workspaceId })).toBe(0);
  });
});

describe('S4 import entry workflows', () => {
  it('TEST-ING-001-U01/U02 rejects empty and cross-Space uploadRefs before writes', async () => {
    const ingestion = ingestionApplication();
    await expect(
      ingestion.dispatch({
        operationId: 'API-IMPORT-FILES',
        params: { spaceId },
        query: {},
        headers: { 'idempotency-key': `empty-files-${suffix}-001` },
        body: {
          uploadIds: [],
          parseProvider: 'liteparse',
          parseConfig: {},
          chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
        },
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });

    const foreignUploadId = id();
    objectBytes.set(`uploads/${foreignUploadId}/foreign.txt`, Buffer.from('foreign'));
    uploadRefs.set(foreignUploadId, {
      ...uploadRef(foreignUploadId, 'foreign.txt', 'text/plain'),
      knowledgeSpaceId: id(),
    });
    await expect(
      ingestion.dispatch({
        operationId: 'API-IMPORT-FILES',
        params: { spaceId },
        query: {},
        headers: { 'idempotency-key': `foreign-files-${suffix}-1` },
        body: {
          uploadIds: [foreignUploadId],
          parseProvider: 'liteparse',
          parseConfig: {},
          chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
        },
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    expect(await connection.models.KnowledgeSource.countDocuments({ workspaceId })).toBe(0);
    expect(await connection.models.KnowledgeJob.countDocuments({ workspaceId })).toBe(0);
    expect(await connection.models.KnowledgeOutboxEvent.countDocuments({ workspaceId })).toBe(0);
  });

  it('TEST-ING-002-U01/U02 validates text bounds and path/body Space consistency', async () => {
    const ingestion = ingestionApplication();
    const base = {
      operationId: 'API-IMPORT-TEXT' as const,
      params: { spaceId },
      query: {},
      context,
    };
    for (const [index, text] of [
      [1, ''],
      [2, 'x'.repeat(10_000_001)],
    ] as const) {
      await expect(
        ingestion.dispatch({
          ...base,
          headers: { 'idempotency-key': `text-bounds-${suffix}-000${index}` },
          body: {
            knowledgeSpaceId: spaceId,
            name: `bounds-${index}`,
            directoryId: null,
            text,
            chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
          },
        }),
      ).rejects.toMatchObject({
        problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
      });
    }
    await expect(
      ingestion.dispatch({
        ...base,
        headers: { 'idempotency-key': `text-space-${suffix}-0001` },
        body: {
          knowledgeSpaceId: id(),
          name: 'mismatch',
          directoryId: null,
          text: 'body',
          chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
        },
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    expect(await connection.models.KnowledgeSource.countDocuments({ workspaceId })).toBe(0);
    expect(await connection.models.KnowledgeJob.countDocuments({ workspaceId })).toBe(0);
    expect(await connection.models.KnowledgeOutboxEvent.countDocuments({ workspaceId })).toBe(0);
  });

  it('TEST-X-SECURITY-URL rejection never materializes Source/Job/Audit/Outbox', async () => {
    const counters = newCounters();
    const ingestion = ingestionApplication('template', {
      counters,
      dependencies: {
        urlImport: {
          async fetch() {
            throw Object.assign(new Error('private'), {
              problem: { error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' } },
            });
          },
        },
      },
    });
    await expect(
      ingestion.dispatch({
        operationId: 'API-IMPORT-URL',
        params: { spaceId },
        query: {},
        headers: { 'idempotency-key': `private-url-${suffix}-01` },
        body: {
          url: 'http://169.254.169.254/latest/meta-data',
          selector: 'body',
          directoryId: null,
        },
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' } },
    });
    expect(counters.puts).toHaveLength(0);
    expect(await connection.models.KnowledgeSource.countDocuments({ workspaceId })).toBe(0);
    expect(await connection.models.KnowledgeJob.countDocuments({ workspaceId })).toBe(0);
    expect(await connection.models.KnowledgeAuditEvent.countDocuments({ workspaceId })).toBe(0);
    expect(await connection.models.KnowledgeOutboxEvent.countDocuments({ workspaceId })).toBe(0);
  });

  it('TEST-X-S4-NO-QUEUE leaves delivery in pending Outbox without enqueue', async () => {
    const queuePort = {
      enqueue: vi.fn(),
      remove: vi.fn(),
      close: vi.fn(),
    };
    const ingestion = ingestionApplication('template', {
      dependencies: { queuePort },
    });
    await expect(
      ingestion.dispatch({
        operationId: 'API-IMPORT-TEXT',
        params: { spaceId },
        query: {},
        headers: { 'idempotency-key': `no-queue-${suffix}-0001` },
        body: {
          knowledgeSpaceId: spaceId,
          name: 'No queue',
          directoryId: null,
          text: 'Outbox only',
          chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
        },
        context,
      }),
    ).resolves.toMatchObject({ status: 202 });
    expect(queuePort.enqueue).toHaveBeenCalledTimes(0);
    const outbox = await connection.models.KnowledgeOutboxEvent.find({ workspaceId }).lean();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      status: 'pending',
      payload: expect.objectContaining({ queue: 'knowledge-import' }),
    });
  });

  it('TEST-ING-002-U03/TEST-DOWN-004-U03 replays text without a second PUT', async () => {
    const counters = newCounters();
    const ingestion = ingestionApplication('template', { counters });
    const input = {
      operationId: 'API-IMPORT-TEXT' as const,
      params: { spaceId },
      query: {},
      headers: { 'idempotency-key': `text-replay-${suffix}-01` },
      body: {
        knowledgeSpaceId: spaceId,
        name: 'Replay note',
        directoryId: null,
        text: 'Replay me only once',
        chunking: { trainingType: 'chunk' as const, chunkSettingMode: 'auto' as const },
      },
      context,
    };
    const first = await ingestion.dispatch(input);
    const second = await ingestion.dispatch(input);
    expect(second.data).toMatchObject({ jobId: (first.data as { jobId: string }).jobId });
    expect(counters.puts).toHaveLength(1);
    expect(counters.deletes).toHaveLength(0);
    expect(await connection.models.KnowledgeJob.countDocuments({ workspaceId })).toBe(1);
    expect(await connection.models.KnowledgeSource.countDocuments({ workspaceId })).toBe(1);
    expect(await connection.models.KnowledgeOutboxEvent.countDocuments({ workspaceId })).toBe(1);
  });

  it('TEST-DOWN-004-U03 replays URL and API library before provider/object calls', async () => {
    const counters = newCounters();
    const ingestion = ingestionApplication('template', { counters });
    const urlInput = {
      operationId: 'API-IMPORT-URL' as const,
      params: { spaceId },
      query: {},
      headers: { 'idempotency-key': `url-replay-${suffix}-0001` },
      body: { url: 'https://example.com/docs', selector: 'body', directoryId: null },
      context,
    };
    await ingestion.dispatch(urlInput);
    await ingestion.dispatch(urlInput);
    expect(counters.urlFetches).toBe(1);
    expect(counters.puts).toHaveLength(1);

    const apiInput = {
      operationId: 'API-IMPORT-API-LIBRARY' as const,
      params: { spaceId },
      query: {},
      headers: { 'idempotency-key': `api-replay-${suffix}-0001` },
      body: {
        config: {
          provider: 'custom_api',
          baseUrl: 'https://api.example.com',
          catalogPath: '/v1/file/list',
          detailPath: '/v1/file/detail',
          contentPath: '/v1/file/content',
          previewPath: '/v1/file/read',
          pageMode: 'cursor',
        },
        credentials: { provider: 'custom_api', authMode: 'none' },
        fileIds: ['file:1'],
        directoryId: null,
      },
      context,
    };
    await ingestion.dispatch(apiInput);
    await ingestion.dispatch(apiInput);
    expect(counters.customApiContent).toBe(1);
    expect(counters.puts).toHaveLength(2);
  });

  it('TEST-X-S4-FAULT compensates every earlier object when a later materialization fails', async () => {
    const counters = newCounters();
    const ingestion = ingestionApplication('template', {
      counters,
      failMaterializeOn: 2,
    });
    await expect(
      ingestion.dispatch({
        operationId: 'API-IMPORT-API-LIBRARY',
        params: { spaceId },
        query: {},
        headers: { 'idempotency-key': `compensate-${suffix}-01` },
        body: {
          config: {
            provider: 'custom_api',
            baseUrl: 'https://api.example.com',
            catalogPath: '/v1/file/list',
            detailPath: '/v1/file/detail',
            contentPath: '/v1/file/content',
            previewPath: '/v1/file/read',
            pageMode: 'none',
          },
          credentials: { provider: 'custom_api', authMode: 'none' },
          fileIds: ['file:1', 'file:2'],
          directoryId: null,
        },
        context,
      }),
    ).rejects.toThrow('injected-materialization-failure');
    expect(counters.puts).toHaveLength(1);
    expect(counters.deletes).toEqual(counters.puts);
    expect(await connection.models.KnowledgeJob.countDocuments({ workspaceId })).toBe(0);
    expect(await connection.models.KnowledgeSource.countDocuments({ workspaceId })).toBe(0);
    expect(await connection.models.KnowledgeOutboxEvent.countDocuments({ workspaceId })).toBe(0);
  });

  it('TEST-DOWN-004-U05 returns quota failure before file drafts or object writes', async () => {
    const uploadId = id();
    objectBytes.set(`uploads/${uploadId}/quota.txt`, Buffer.from('quota'));
    uploadRefs.set(uploadId, uploadRef(uploadId, 'quota.txt', 'text/plain'));
    const counters = newCounters();
    const quotaGate = {
      async check() {
        throw Object.assign(new Error('quota'), {
          problem: { error: { code: 'KNOWLEDGE_QUOTA_EXCEEDED' } },
        });
      },
    };
    const ingestion = ingestionApplication('template', {
      counters,
      dependencies: { quotaGate },
    });
    await expect(
      ingestion.dispatch({
        operationId: 'API-IMPORT-FILES',
        params: { spaceId },
        query: {},
        headers: { 'idempotency-key': `quota-${suffix}-000001` },
        body: {
          uploadIds: [uploadId],
          parseProvider: 'liteparse',
          parseConfig: {},
          chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
        },
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_QUOTA_EXCEEDED' } },
    });
    expect(counters.puts).toHaveLength(0);
    expect(await connection.models.KnowledgeSource.countDocuments({ workspaceId })).toBe(0);
    expect(await connection.models.KnowledgeJob.countDocuments({ workspaceId })).toBe(0);
    expect(await connection.models.KnowledgeAuditEvent.countDocuments({ workspaceId })).toBe(0);
    expect(await connection.models.KnowledgeOutboxEvent.countDocuments({ workspaceId })).toBe(0);
  });

  it('TEST-DOWN-004-U01 blocks API catalog without write scope before provider access', async () => {
    const counters = newCounters();
    const ingestion = ingestionApplication('template', { counters });
    await expect(
      ingestion.dispatch({
        operationId: 'API-IMPORT-API-CATALOG',
        params: { spaceId },
        query: {},
        headers: {},
        body: {
          config: {
            provider: 'custom_api',
            baseUrl: 'https://api.example.com',
            catalogPath: '/v1/file/list',
            detailPath: '/v1/file/detail',
            contentPath: '/v1/file/content',
            previewPath: '/v1/file/read',
            pageMode: 'none',
          },
          credentials: { provider: 'custom_api', authMode: 'none' },
          parentId: '',
        },
        context: { ...context, scopes: ['knowledge:read'] },
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
    expect(counters.customApiCatalog).toBe(0);
  });

  it('TEST-X-TENANT-GUARD blocks an inaccessible target Space before provider writes', async () => {
    const counters = newCounters();
    const ingestion = ingestionApplication('template', {
      counters,
      dependencies: {
        access: {
          async assertPermission() {
            throw Object.assign(new Error('space hidden'), {
              problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
            });
          },
        } as never,
      },
    });
    await expect(
      ingestion.dispatch({
        operationId: 'API-IMPORT-API-CATALOG',
        params: { spaceId },
        query: {},
        headers: {},
        body: {
          config: {
            provider: 'custom_api',
            baseUrl: 'https://api.example.com',
            catalogPath: '/v1/file/list',
            detailPath: '/v1/file/detail',
            contentPath: '/v1/file/content',
            previewPath: '/v1/file/read',
            pageMode: 'none',
          },
          credentials: { provider: 'custom_api', authMode: 'none' },
          parentId: '',
        },
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
    });
    expect(counters.customApiCatalog).toBe(0);
    expect(await connection.models.KnowledgeSource.countDocuments({ workspaceId })).toBe(0);
    expect(await connection.models.KnowledgeJob.countDocuments({ workspaceId })).toBe(0);
    expect(await connection.models.KnowledgeOutboxEvent.countDocuments({ workspaceId })).toBe(0);
  });

  it('TEST-ING-003-BLOCK/TEST-ING-006-BLOCK submits URL and API imports without parsing', async () => {
    const ingestion = ingestionApplication();
    const url = await ingestion.dispatch({
      operationId: 'API-IMPORT-URL',
      params: { spaceId },
      query: {},
      headers: { 'idempotency-key': `url-${suffix}-00000001` },
      body: {
        url: 'https://example.com/docs',
        selector: 'main',
        directoryId: null,
      },
      context,
    });
    expect(url.status).toBe(202);
    const api = await ingestion.dispatch({
      operationId: 'API-IMPORT-API-LIBRARY',
      params: { spaceId },
      query: {},
      headers: { 'idempotency-key': `api-${suffix}-00000001` },
      body: {
        config: {
          provider: 'custom_api',
          baseUrl: 'https://example.com',
          catalogPath: '/v1/file/list',
          detailPath: '/v1/file/detail',
          contentPath: '/v1/file/content',
          previewPath: '/v1/file/read',
          pageMode: 'cursor',
        },
        credentials: { provider: 'custom_api', authMode: 'none' },
        fileIds: ['file:1'],
        directoryId: null,
      },
      context,
    });
    expect(api.status).toBe(202);
    expect(
      await connection.models.KnowledgeJob.countDocuments({ workspaceId, kind: 'import' }),
    ).toBe(2);
    expect(await connection.models.KnowledgeSource.countDocuments({ workspaceId })).toBe(2);
    expect(
      await connection.models.KnowledgeJob.countDocuments({ workspaceId, kind: 'parse' }),
    ).toBe(0);
  });

  it('TEST-ING-004-BLOCK/TEST-ING-005-U02/TEST-X-S4-BACKUP-DRYRUN keeps dry-run free of Source/Audit/Outbox', async () => {
    const templateUpload = new mongoose.Types.ObjectId().toString();
    objectBytes.set(
      `uploads/${templateUpload}/template.csv`,
      Buffer.from('q,a\nTemplate question,Template answer\n'),
    );
    uploadRefs.set(templateUpload, uploadRef(templateUpload, 'template.csv', 'text/csv'));
    const template = ingestionApplication('template');
    const templateResult = await template.dispatch({
      operationId: 'API-IMPORT-TEMPLATE',
      params: { spaceId },
      query: {},
      headers: { 'idempotency-key': `template-${suffix}-0001` },
      body: { uploadId: templateUpload, directoryId: null },
      context,
    });
    expect(templateResult.status).toBe(202);

    const backupUpload = new mongoose.Types.ObjectId().toString();
    objectBytes.set(
      `uploads/${backupUpload}/backup.csv`,
      Buffer.from('q,a,index,metadata,schemaVersion\nBackup question,Backup answer,,"{}",1\n'),
    );
    uploadRefs.set(backupUpload, uploadRef(backupUpload, 'backup.csv', 'text/csv'));
    const backup = ingestionApplication('backup');
    const before = await connection.models.KnowledgeSource.countDocuments({ workspaceId });
    const beforeAudit = await connection.models.KnowledgeAuditEvent.countDocuments({ workspaceId });
    const beforeOutbox = await connection.models.KnowledgeOutboxEvent.countDocuments({
      workspaceId,
    });
    const dryRun = await backup.dispatch({
      operationId: 'API-IMPORT-BACKUP',
      params: { spaceId },
      query: {},
      headers: { 'idempotency-key': `backup-${suffix}-0001` },
      body: {
        uploadId: backupUpload,
        directoryId: null,
        dryRun: true,
        conflictStrategy: 'fail',
      },
      context,
    });
    expect(dryRun.status).toBe(202);
    expect((dryRun.data as { status: string; result: { dryRun: boolean } }).status).toBe(
      'succeeded',
    );
    expect((dryRun.data as { result: { dryRun: boolean } }).result.dryRun).toBe(true);
    expect(await connection.models.KnowledgeSource.countDocuments({ workspaceId })).toBe(before);
    expect(await connection.models.KnowledgeAuditEvent.countDocuments({ workspaceId })).toBe(
      beforeAudit,
    );
    expect(await connection.models.KnowledgeOutboxEvent.countDocuments({ workspaceId })).toBe(
      beforeOutbox,
    );
  });

  it('TEST-ING-005-U03 overwrite stores the real source version in the parent Job snapshot', async () => {
    const backupUpload = new mongoose.Types.ObjectId().toString();
    objectBytes.set(
      `uploads/${backupUpload}/backup.csv`,
      Buffer.from('q,a,index,metadata,schemaVersion\nBackup question,Backup answer,,"{}",1\n'),
    );
    uploadRefs.set(backupUpload, uploadRef(backupUpload, 'backup.csv', 'text/csv'));
    const backup = ingestionApplication('backup');
    const first = await backup.dispatch({
      operationId: 'API-IMPORT-BACKUP',
      params: { spaceId },
      query: {},
      headers: { 'idempotency-key': `backup-overwrite-${suffix}-01` },
      body: {
        uploadId: backupUpload,
        directoryId: null,
        dryRun: false,
        conflictStrategy: 'fail',
      },
      context,
    });
    const firstSource = await connection.models.KnowledgeSource.findOne({ workspaceId }).lean();
    expect(firstSource).not.toBeNull();
    expect(firstSource?.sourceVersion).toBe(1);

    const overwrite = await backup.dispatch({
      operationId: 'API-IMPORT-BACKUP',
      params: { spaceId },
      query: {},
      headers: { 'idempotency-key': `backup-overwrite-${suffix}-02` },
      body: {
        uploadId: backupUpload,
        directoryId: null,
        dryRun: false,
        conflictStrategy: 'overwrite',
      },
      context,
    });
    const overwritten = await connection.models.KnowledgeSource.findById(firstSource!._id).lean();
    expect(overwritten).toMatchObject({ sourceVersion: 2, version: 2 });
    const job = await connection.models.KnowledgeJob.findById(
      (overwrite.data as { jobId: string }).jobId,
    ).lean();
    expect(job?.inputSnapshot.sourceVersions).toMatchObject({
      [String(firstSource!._id)]: 2,
    });
    expect(first.status).toBe(202);

    const concurrent = await Promise.allSettled([
      backup.dispatch({
        operationId: 'API-IMPORT-BACKUP',
        params: { spaceId },
        query: {},
        headers: { 'idempotency-key': `backup-overwrite-${suffix}-03` },
        body: {
          uploadId: backupUpload,
          directoryId: null,
          dryRun: false,
          conflictStrategy: 'overwrite',
        },
        context,
      }),
      backup.dispatch({
        operationId: 'API-IMPORT-BACKUP',
        params: { spaceId },
        query: {},
        headers: { 'idempotency-key': `backup-overwrite-${suffix}-04` },
        body: {
          uploadId: backupUpload,
          directoryId: null,
          dryRun: false,
          conflictStrategy: 'overwrite',
        },
        context,
      }),
    ]);
    expect(concurrent.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(await connection.models.KnowledgeSource.findById(firstSource!._id).lean()).toMatchObject(
      { version: 3, sourceVersion: 3 },
    );
  });
});
