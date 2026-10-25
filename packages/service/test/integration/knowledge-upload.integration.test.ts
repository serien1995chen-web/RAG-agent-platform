import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KnowledgeApiError } from '@kb/contracts';
import { FileTicketService, MinioKnowledgeObjectStore } from '../../../../sdk/storage/src/index';
import { FileApplication } from '../../src/modules/knowledge/application/file.application';
import { SourceFileApplication } from '../../src/modules/knowledge/application/source-preview';
import {
  UPLOAD_MAX_BYTES,
  UPLOAD_PART_SIZE_BYTES,
} from '../../src/modules/knowledge/application/file.application';
import type { AccessPort, CatalogPort } from '../../src/modules/knowledge/application/ports';
import { KnowledgeObjectRefRepository } from '../../src/modules/knowledge/repository/object-ref.repository';
import { KnowledgeArchiveRepository } from '../../src/modules/knowledge/repository/archive.repository';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
} from '../../src/shared/persistence/schemas/knowledge-index';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const context: TenantContext = {
  workspaceId: `ws_upload_${suffix}`,
  memberId: `mem_upload_${suffix}`,
  requestId: `req_upload_${suffix}`,
  traceId: suffix.padEnd(32, '0').slice(0, 32),
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
};
const knowledgeSpaceId = new mongoose.Types.ObjectId().toString();
const createdObjects = new Set<string>();

let connection: mongoose.Connection;
let objectStore: MinioKnowledgeObjectStore;
let repository: KnowledgeObjectRefRepository;
let files: FileApplication;
let fileTickets: FileTicketService;

const catalog = {
  async getSpace(id: string) {
    return { id, knowledgeSpaceId: id };
  },
} as unknown as CatalogPort;
const access = {
  async assertPermission() {
    return { allowed: true };
  },
} as unknown as AccessPort;

function errorCode(error: unknown): string {
  expect(error).toBeInstanceOf(KnowledgeApiError);
  return (error as KnowledgeApiError).problem.error.code;
}

async function putSingle(
  sizeBytes: number,
  name = 'upload.txt',
  body = Buffer.from('knowledge upload'),
) {
  const session = await files.init(
    {
      knowledgeSpaceId,
      name,
      mimeType: 'text/plain',
      sizeBytes,
    },
    context,
  );
  const ref = await repository.findObjectRef(session.uploadId, context);
  if (!ref) throw new Error('upload object ref missing');
  createdObjects.add(ref.objectKey);
  const presigned = await files.presign(session.uploadId, { partNumbers: [1] }, context);
  const response = await fetch(presigned.uploads[0]!.url, {
    method: 'PUT',
    headers: presigned.uploads[0]!.headers,
    body,
  });
  expect(response.status).toBe(200);
  return { session, ref };
}

beforeAll(async () => {
  const mongoUri = new URL(
    process.env.KB_TEST_MONGO_URI ??
      `mongodb://127.0.0.1:27017/kb_s2_${suffix}?directConnection=true`,
  );
  if (mongoUri.hostname === '127.0.0.1' || mongoUri.hostname === 'localhost') {
    mongoUri.searchParams.set('directConnection', 'true');
  }
  connection = mongoose.createConnection(mongoUri.toString(), {
    serverSelectionTimeoutMS: 5_000,
  });
  await connection.asPromise();
  await ensureKnowledgeCollections(connection);

  const endpoint = new URL(process.env.KB_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000');
  objectStore = new MinioKnowledgeObjectStore({
    provider: 'minio',
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
    useSSL: endpoint.protocol === 'https:',
    accessKey: process.env.KB_TEST_S3_ACCESS_KEY ?? 'minioadmin',
    secretKey: process.env.KB_TEST_S3_SECRET_KEY ?? 'minioadmin',
    region: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
    bucket: process.env.KB_TEST_S3_BUCKET ?? 'kb-test',
  });
  repository = new KnowledgeObjectRefRepository(connection);
  fileTickets = new FileTicketService(
    'integration-file-ticket-secret-at-least-32-bytes',
    'http://127.0.0.1:3010',
  );
  files = new FileApplication(repository, objectStore, catalog, access, fileTickets);
}, 60_000);

afterAll(async () => {
  for (const key of createdObjects) {
    await objectStore
      .deleteObject(key, {
        workspaceId: context.workspaceId,
        knowledgeSpaceId,
        requestId: context.requestId,
        traceId: context.traceId,
      })
      .catch(() => undefined);
  }
  if (connection) {
    for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
      const model = connection.models[entry.modelName];
      if (model) await model.deleteMany({ workspaceId: context.workspaceId });
    }
    await connection.close();
  }
});

describe('TEST-FILE-001-BLOCK upload session', () => {
  it('TEST-FILE-001-U01 completes a single PUT upload', async () => {
    const body = Buffer.from('single upload payload');
    const { session } = await putSingle(body.byteLength, 'single.txt', body);
    const completed = await files.complete({ uploadId: session.uploadId, parts: [] }, context);
    expect(completed.state).toBe('active');
    expect(completed.sizeBytes).toBe(body.byteLength);
    expect(completed.etag.length).toBeGreaterThan(0);
  });

  it('TEST-FILE-001-U02 completes ordered multipart parts', async () => {
    const totalSize = UPLOAD_PART_SIZE_BYTES + 1;
    const session = await files.init(
      {
        knowledgeSpaceId,
        name: 'multipart.txt',
        mimeType: 'text/plain',
        sizeBytes: totalSize,
      },
      context,
    );
    const ref = await repository.findObjectRef(session.uploadId, context);
    if (!ref) throw new Error('upload object ref missing');
    createdObjects.add(ref.objectKey);
    const partOne = await files.uploadPart(
      session.uploadId,
      1,
      Buffer.alloc(UPLOAD_PART_SIZE_BYTES, 'a'),
      context,
    );
    const partTwo = await files.uploadPart(session.uploadId, 2, Buffer.from('b'), context);
    const completed = await files.complete(
      {
        uploadId: session.uploadId,
        parts: [partOne, partTwo],
      },
      context,
    );
    expect(completed.state).toBe('active');
    expect(completed.sizeBytes).toBe(totalSize);
  });

  it('TEST-FILE-001-U03 enforces size and multipart boundaries', async () => {
    for (const sizeBytes of [0, UPLOAD_MAX_BYTES + 1]) {
      const error = await files
        .init(
          {
            knowledgeSpaceId,
            name: 'boundary.txt',
            mimeType: 'text/plain',
            sizeBytes,
          },
          context,
        )
        .catch((caught: unknown) => caught);
      expect(errorCode(error)).toBe('KNOWLEDGE_PAYLOAD_TOO_LARGE');
    }
    const exactPart = await files.init(
      {
        knowledgeSpaceId,
        name: 'boundary.txt',
        mimeType: 'text/plain',
        sizeBytes: UPLOAD_PART_SIZE_BYTES,
      },
      context,
    );
    expect(exactPart.mode).toBe('single');
    const overPart = await files.init(
      {
        knowledgeSpaceId,
        name: 'boundary.txt',
        mimeType: 'text/plain',
        sizeBytes: UPLOAD_PART_SIZE_BYTES + 1,
      },
      context,
    );
    expect(overPart.mode).toBe('multipart');
    const maxFile = await files.init(
      {
        knowledgeSpaceId,
        name: 'boundary.txt',
        mimeType: 'text/plain',
        sizeBytes: UPLOAD_MAX_BYTES,
      },
      context,
    );
    expect(maxFile.mode).toBe('multipart');
  });

  it('TEST-FILE-001-U04 rejects more than 10000 parts', async () => {
    const session = await files.init(
      {
        knowledgeSpaceId,
        name: 'parts.txt',
        mimeType: 'text/plain',
        sizeBytes: 1,
      },
      context,
    );
    const error = await files
      .presign(
        session.uploadId,
        { partNumbers: Array.from({ length: 10_001 }, (_, index) => index + 1) },
        context,
      )
      .catch((caught: unknown) => caught);
    expect(errorCode(error)).toBe('KNOWLEDGE_PAYLOAD_TOO_LARGE');
  });

  it('TEST-FILE-001-U05 rejects disguised MIME and double extensions', async () => {
    const error = await files
      .init(
        {
          knowledgeSpaceId,
          name: 'disguised.pdf.exe',
          mimeType: 'application/pdf',
          sizeBytes: 10,
        },
        context,
      )
      .catch((caught: unknown) => caught);
    expect(errorCode(error)).toBe('KNOWLEDGE_UNSUPPORTED_CONTENT');
  });

  it('TEST-FILE-001-U06 allows only one winner for complete versus abort', async () => {
    const body = Buffer.from('complete-abort-race');
    const { session } = await putSingle(body.byteLength, 'race.txt', body);
    const results = await Promise.allSettled([
      files.complete({ uploadId: session.uploadId, parts: [] }, context),
      files.abort(session.uploadId, session.version, context),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('TEST-FILE-001-U07 returns the same object for repeated complete', async () => {
    const body = Buffer.from('repeat-complete');
    const { session } = await putSingle(body.byteLength, 'repeat.txt', body);
    const first = await files.complete({ uploadId: session.uploadId, parts: [] }, context);
    const second = await files.complete({ uploadId: session.uploadId, parts: [] }, context);
    expect(second.blobId).toBe(first.blobId);
    expect(second.etag).toBe(first.etag);
  });

  it('TEST-FILE-001-U08 hides uploads from another workspace', async () => {
    const body = Buffer.from('tenant-isolation');
    const { session } = await putSingle(body.byteLength, 'tenant.txt', body);
    const error = await files
      .get(session.uploadId, { ...context, workspaceId: `${context.workspaceId}_other` })
      .catch((caught: unknown) => caught);
    expect(errorCode(error)).toBe('KNOWLEDGE_NOT_FOUND');
  });

  it('TEST-FILE-003-BLOCK issues tickets and enforces content ACL and Range', async () => {
    const body = Buffer.from('0123456789');
    const { session } = await putSingle(body.byteLength, 'access.txt', body);
    const completed = await files.complete({ uploadId: session.uploadId, parts: [] }, context);
    const source = await connection.models.KnowledgeSource.create({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: new mongoose.Types.ObjectId(knowledgeSpaceId),
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      kind: 'file',
      name: 'access.txt',
      blobRefId: new mongoose.Types.ObjectId(completed.blobId),
      mimeType: 'text/plain',
      sizeBytes: body.byteLength,
      ownershipMemberId: context.memberId,
    });
    await connection.models.KnowledgeObjectRef.updateOne(
      { workspaceId: context.workspaceId, _id: new mongoose.Types.ObjectId(completed.blobId) },
      { $set: { sourceId: source._id } },
    );

    const preview = await files.preview(completed.blobId, { ttlSeconds: 60 }, context);
    expect(preview.url).toContain(completed.blobId);
    expect(preview.disposition).toBe('inline');
    const download = await files.download(completed.blobId, { ttlSeconds: 300 }, context);
    expect(download.disposition).toBe('attachment');

    const normal = await files.content(completed.blobId, 'bytes=0-1', null, context);
    expect(normal.contentRange).toBe('bytes 0-1/10');
    const chunks: Buffer[] = [];
    for await (const chunk of normal.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('01');

    const ticket = new URL(download.url).searchParams.get('ticket');
    expect(ticket).not.toBeNull();
    const crossWorkspaceError = await files
      .content(completed.blobId, null, ticket, {
        ...context,
        workspaceId: `${context.workspaceId}_other`,
      })
      .catch((error: unknown) => error);
    expect(errorCode(crossWorkspaceError)).toBe('KNOWLEDGE_FORBIDDEN');

    const sourceCatalog = {
      async getSource(id: string) {
        const document = await connection.models.KnowledgeSource.findById(id).lean();
        if (!document) throw new Error('source missing');
        return {
          ...(document as unknown as Record<string, unknown>),
          id: String(document._id),
          knowledgeSpaceId: String(document.knowledgeSpaceId),
          blobRefId: String(document.blobRefId),
        };
      },
      async listSegments() {
        return { items: [], pageInfo: { nextCursor: null, hasMore: false } };
      },
    } as unknown as CatalogPort;
    const sourceFiles = new SourceFileApplication(
      sourceCatalog,
      new KnowledgeArchiveRepository(connection),
      access,
      repository,
      objectStore,
      fileTickets,
    );
    const sourcePreview = await sourceFiles.preview(String(source._id), context);
    expect(sourcePreview.sections[0]?.text).toBe(body.toString());
    const sourceDownload = await sourceFiles.download(String(source._id), context);
    expect(sourceDownload.disposition).toBe('attachment');
    const archive = await sourceFiles.archive(knowledgeSpaceId, [String(source._id)], context);
    expect(archive.kind).toBe('export');
    expect(archive.status).toBe('queued');
  });
});
