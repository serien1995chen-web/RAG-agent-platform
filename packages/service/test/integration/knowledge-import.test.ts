import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeImportRepository } from '../../src/modules/knowledge/repository/import.repository';
import {
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';
import type { ImportSubmissionCommand } from '../../src/modules/knowledge/application/ingestion.ports';
import { requestHashOf } from '../../src/modules/knowledge/domain/import-submission';
import {
  FixtureScopedAuthPort,
  S04IngestionApplication,
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

function ingestionApplication(rowMode: 'template' | 'backup' = 'template') {
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
      objectBytes.delete(key);
      return { deleted: true };
    },
  };
  return new S04IngestionApplication({
    imports: repository,
    connectors: {} as never,
    objectRefs: {
      async findObjectRef(id) {
        return uploadRefs.get(id) ?? null;
      },
    },
    content: new KnowledgeIngestionContentAdapter(objectStore),
    urlImport: {
      async fetch(input) {
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
    customApi: {
      async catalog() {
        return {
          provider: 'custom' as const,
          items: [{ id: 'file:1', name: 'API Doc', type: 'document' as const }],
        };
      },
      async content(input) {
        return input.fileIds.map((externalId) => ({
          externalId,
          title: 'API Doc',
          mimeType: 'text/plain',
          bytes: Buffer.from('API content'),
        }));
      },
    },
    providers: {} as never,
    access: {
      async assertPermission() {
        return undefined;
      },
    } as never,
    scopedAuth: new FixtureScopedAuthPort(),
    templateParser: {
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

  it('replays identical key/body and rejects a mismatched body', async () => {
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

  it('rolls back Source/Job/Audit when Outbox creation fails', async () => {
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
  it('submits URL and API library imports through C1 without parsing', async () => {
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

  it('keeps template and backup dry-run side effects separate', async () => {
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
  });
});
