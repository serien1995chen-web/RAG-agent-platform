import { randomUUID } from 'node:crypto';
import { deflateRawSync, crc32 } from 'node:zlib';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KnowledgeApiError } from '@kb/contracts';
import { FileTicketService, MinioKnowledgeObjectStore } from '../../../../sdk/storage/src/index';
import { ObjectStoreArchiveSafetyAdapter } from '../../../../projects/app/src/runtime/archive-safety.adapter';
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

interface TestZipEntry {
  name: string;
  data: Buffer;
}

function buildZip(entries: TestZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const checksum = crc32(entry.data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localParts.push(localHeader, nameBytes, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + compressed.length;
  }
  const local = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

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
  files = new FileApplication(
    repository,
    objectStore,
    catalog,
    access,
    fileTickets,
    new ObjectStoreArchiveSafetyAdapter(objectStore),
  );
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

  it('TEST-FILE-001-U13 accepts a valid ZIP container through real MinIO inspection', async () => {
    const body = buildZip([{ name: 'hello.txt', data: Buffer.from('hello') }]);
    const session = await files.init(
      {
        knowledgeSpaceId,
        name: 'valid.zip',
        mimeType: 'application/zip',
        sizeBytes: body.byteLength,
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

    const completed = await files.complete({ uploadId: session.uploadId, parts: [] }, context);
    expect(completed.state).toBe('active');
    expect(completed.mimeType).toBe('application/zip');
  });

  it('TEST-FILE-001-U14 rejects a ratio bomb, deletes the object and never marks it active', async () => {
    const body = buildZip([{ name: 'bomb.txt', data: Buffer.alloc(17 * 1024 * 1024) }]);
    const session = await files.init(
      {
        knowledgeSpaceId,
        name: 'bomb.zip',
        mimeType: 'application/zip',
        sizeBytes: body.byteLength,
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

    const error = await files
      .complete({ uploadId: session.uploadId, parts: [] }, context)
      .catch((caught: unknown) => caught);
    expect(errorCode(error)).toBe('KNOWLEDGE_UNSUPPORTED_CONTENT');

    const after = await repository.findObjectRef(session.uploadId, context);
    expect(after?.state).not.toBe('active');
    expect((await files.get(session.uploadId, context)).status).toBe('aborted');
    const headError = await objectStore
      .headObject(objectStore.bucket, ref.objectKey, {
        workspaceId: context.workspaceId,
        knowledgeSpaceId,
        requestId: context.requestId,
        traceId: context.traceId,
      })
      .catch((caught: unknown) => caught);
    expect(errorCode(headError)).toBe('KNOWLEDGE_NOT_FOUND');
  });

  it('TEST-FILE-001-U17 maps archive entry limits to 413 and cleans the upload', async () => {
    const body = buildZip(
      Array.from({ length: 2001 }, (_, index) => ({
        name: `entry-${index}.txt`,
        data: Buffer.alloc(0),
      })),
    );
    const session = await files.init(
      {
        knowledgeSpaceId,
        name: 'too-many-entries.zip',
        mimeType: 'application/zip',
        sizeBytes: body.byteLength,
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

    const error = await files
      .complete({ uploadId: session.uploadId, parts: [] }, context)
      .catch((caught: unknown) => caught);
    expect(errorCode(error)).toBe('KNOWLEDGE_PAYLOAD_TOO_LARGE');
    expect((await files.get(session.uploadId, context)).status).toBe('aborted');
  });

  it('TEST-FILE-001-U19 fails closed when ZIP safety inspection is unavailable', async () => {
    const body = buildZip([{ name: 'hello.txt', data: Buffer.from('hello') }]);
    const withoutInspector = new FileApplication(
      repository,
      objectStore,
      catalog,
      access,
      fileTickets,
    );
    const session = await withoutInspector.init(
      {
        knowledgeSpaceId,
        name: 'missing-inspector.zip',
        mimeType: 'application/zip',
        sizeBytes: body.byteLength,
      },
      context,
    );
    const ref = await repository.findObjectRef(session.uploadId, context);
    if (!ref) throw new Error('upload object ref missing');
    createdObjects.add(ref.objectKey);
    const presigned = await withoutInspector.presign(
      session.uploadId,
      { partNumbers: [1] },
      context,
    );
    const response = await fetch(presigned.uploads[0]!.url, {
      method: 'PUT',
      headers: presigned.uploads[0]!.headers,
      body,
    });
    expect(response.status).toBe(200);

    const error = await withoutInspector
      .complete({ uploadId: session.uploadId, parts: [] }, context)
      .catch((caught: unknown) => caught);
    expect(errorCode(error)).toBe('KNOWLEDGE_DEPENDENCY_UNAVAILABLE');
    expect((await withoutInspector.get(session.uploadId, context)).status).toBe('aborted');
    const headError = await objectStore
      .headObject(objectStore.bucket, ref.objectKey, {
        workspaceId: context.workspaceId,
        knowledgeSpaceId,
        requestId: context.requestId,
        traceId: context.traceId,
      })
      .catch((caught: unknown) => caught);
    expect(errorCode(headError)).toBe('KNOWLEDGE_NOT_FOUND');
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
      new ObjectStoreArchiveSafetyAdapter(objectStore),
    );
    const sourcePreview = await sourceFiles.preview(String(source._id), context);
    expect(sourcePreview.sections[0]?.text).toBe(body.toString());
    const sourceDownload = await sourceFiles.download(String(source._id), context);
    expect(sourceDownload.disposition).toBe('attachment');
    const archive = await sourceFiles.archive(knowledgeSpaceId, [String(source._id)], context);
    expect(archive.kind).toBe('export');
    expect(archive.status).toBe('queued');

    await connection.models.KnowledgeSource.updateOne(
      { workspaceId: context.workspaceId, _id: source._id },
      { $set: { name: '../escape.txt' } },
    );
    const jobsBefore = await connection.models.KnowledgeJob.countDocuments({
      workspaceId: context.workspaceId,
      kind: 'export',
    });
    const unsafeArchive = await sourceFiles
      .archive(knowledgeSpaceId, [String(source._id)], context)
      .catch((caught: unknown) => caught);
    expect(errorCode(unsafeArchive)).toBe('KNOWLEDGE_UNSUPPORTED_CONTENT');
    expect(
      await connection.models.KnowledgeJob.countDocuments({
        workspaceId: context.workspaceId,
        kind: 'export',
      }),
    ).toBe(jobsBefore);
  });
});
