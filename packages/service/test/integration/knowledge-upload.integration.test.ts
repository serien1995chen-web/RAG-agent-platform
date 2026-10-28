import { createHash, randomUUID } from 'node:crypto';
import { deflateRawSync, crc32 } from 'node:zlib';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { KnowledgeApiError, createKnowledgeError } from '@kb/contracts';
import { FileTicketService, MinioKnowledgeObjectStore } from '../../../../sdk/storage/src/index';
import { ObjectStoreArchiveSafetyAdapter } from '../../../../projects/app/src/runtime/archive-safety.adapter';
import { FileApplication } from '../../src/modules/knowledge/application/file.application';
import { S8FileTicketAdapter } from '../../src/modules/knowledge/adapter/s8-file-ticket.adapter';
import { ObjectLifecycleService } from '../../src/modules/knowledge/application/object-lifecycle';
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
let lifecycle: ObjectLifecycleService;

interface TestZipEntry {
  name: string;
  data: Buffer;
  compressedSize?: number;
}

function buildZip(entries: TestZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const compressedSize = entry.compressedSize ?? compressed.length;
    const stored = Buffer.alloc(compressedSize);
    compressed.copy(stored);
    const checksum = crc32(entry.data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressedSize, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localParts.push(localHeader, nameBytes, stored);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + stored.length;
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
const deniedSources = new Set<string>();
const assertPermission = vi.fn(async (resourceType: string, resourceId: string) => {
  if (resourceType === 'source' && deniedSources.has(resourceId)) {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_FORBIDDEN',
      requestId: context.requestId,
      traceId: context.traceId,
    });
  }
  return { allowed: true };
});
const access = {
  assertPermission,
} as unknown as AccessPort;

function errorCode(error: unknown): string {
  expect(error).toBeInstanceOf(KnowledgeApiError);
  return (error as KnowledgeApiError).problem.error.code;
}

async function putSingle(
  sizeBytes: number,
  name = 'upload.txt',
  body = Buffer.from('knowledge upload'),
  mimeType = 'text/plain',
) {
  const session = await files.init(
    {
      knowledgeSpaceId,
      name,
      mimeType,
      sizeBytes,
    },
    context,
  );
  const ref = await repository.findObjectRef(session.uploadId, context);
  if (!ref) throw new Error('upload object ref missing');
  createdObjects.add(ref.objectKey);
  if (ref.finalObjectKey) createdObjects.add(ref.finalObjectKey);
  const presigned = await files.presign(session.uploadId, { partNumbers: [1] }, context);
  const response = await fetch(presigned.uploads[0]!.url, {
    method: 'PUT',
    headers: presigned.uploads[0]!.headers,
    body,
  });
  expect(response.status).toBe(200);
  return { session, ref, presigned };
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
  lifecycle = new ObjectLifecycleService(repository, objectStore, 500);
}, 60_000);

afterAll(async () => {
  if (connection) {
    const refs = await connection.models.KnowledgeObjectRef.find({
      workspaceId: context.workspaceId,
    }).lean();
    for (const ref of refs) {
      for (const key of [ref.objectKey, ref.upload?.pendingObjectKey, ref.upload?.finalObjectKey]) {
        if (typeof key === 'string' && key.length > 0) createdObjects.add(key);
      }
    }
  }
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
    const mismatched = await files
      .init(
        {
          knowledgeSpaceId,
          name: 'report.pdf',
          mimeType: 'image/png',
          sizeBytes: 10,
        },
        context,
      )
      .catch((caught: unknown) => caught);
    expect(errorCode(mismatched)).toBe('KNOWLEDGE_UNSUPPORTED_CONTENT');

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

  it('TEST-FILE-001-U05 rejects bytes that only claim to be TIFF', async () => {
    const body = Buffer.from('not-a-tiff');
    const session = await files.init(
      {
        knowledgeSpaceId,
        name: 'disguised.tiff',
        mimeType: 'image/tiff',
        sizeBytes: body.byteLength,
      },
      context,
    );
    const ref = await repository.findObjectRef(session.uploadId, context);
    if (!ref) throw new Error('upload object ref missing');
    createdObjects.add(ref.objectKey);
    const presigned = await files.presign(session.uploadId, { partNumbers: [1] }, context);
    const upload = await fetch(presigned.uploads[0]!.url, {
      method: 'PUT',
      headers: presigned.uploads[0]!.headers,
      body,
    });
    expect(upload.status).toBe(200);

    const error = await files
      .complete({ uploadId: session.uploadId, parts: [] }, context)
      .catch((caught: unknown) => caught);
    expect(errorCode(error)).toBe('KNOWLEDGE_UNSUPPORTED_CONTENT');
    expect((await files.get(session.uploadId, context)).status).toBe('aborted');
    expect((await repository.findObjectRef(session.uploadId, context))?.state).not.toBe('active');
  });

  it('TEST-FILE-001-U11 maps uploaded size mismatch to 413 and cleans the object', async () => {
    const declaredSize = 5;
    const body = Buffer.from('too-large');
    const session = await files.init(
      {
        knowledgeSpaceId,
        name: 'size-mismatch.txt',
        mimeType: 'text/plain',
        sizeBytes: declaredSize,
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

  it('TEST-FILE-001-U20 presigns and stores the declared MIME type', async () => {
    const body = Buffer.from('mime');
    const session = await files.init(
      {
        knowledgeSpaceId,
        name: 'mime.txt',
        mimeType: 'text/plain',
        sizeBytes: body.byteLength,
      },
      context,
    );
    const presigned = await files.presign(session.uploadId, { partNumbers: [1] }, context);
    expect(presigned.uploads[0]?.headers['Content-Type']).toBe('text/plain');
    const response = await fetch(presigned.uploads[0]!.url, {
      method: 'PUT',
      headers: presigned.uploads[0]!.headers,
      body,
    });
    expect(response.status).toBe(200);
    const completed = await files.complete({ uploadId: session.uploadId, parts: [] }, context);
    const head = await objectStore.headObject(objectStore.bucket, completed.objectKey, {
      workspaceId: context.workspaceId,
      knowledgeSpaceId,
      requestId: context.requestId,
      traceId: context.traceId,
    });
    expect(head.contentType).toBe('text/plain');
  });

  it('TEST-FILE-001-U12 leaves no active fact when immutable copy fails', async () => {
    const body = Buffer.from('copy failure');
    const failingObjectStore = Object.create(objectStore) as MinioKnowledgeObjectStore;
    failingObjectStore.copyObjectImmutable = vi.fn().mockRejectedValue(
      createKnowledgeError({
        code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { operation: 'copyObjectImmutable' },
      }),
    );
    const failingFiles = new FileApplication(
      repository,
      failingObjectStore,
      catalog,
      access,
      fileTickets,
      new ObjectStoreArchiveSafetyAdapter(failingObjectStore),
    );
    const session = await failingFiles.init(
      {
        knowledgeSpaceId,
        name: 'copy-failure.txt',
        mimeType: 'text/plain',
        sizeBytes: body.byteLength,
      },
      context,
    );
    const ref = await repository.findObjectRef(session.uploadId, context);
    if (!ref) throw new Error('upload object ref missing');
    expect(ref.finalObjectKey).not.toBeNull();
    const presigned = await failingFiles.presign(session.uploadId, { partNumbers: [1] }, context);
    const response = await fetch(presigned.uploads[0]!.url, {
      method: 'PUT',
      headers: presigned.uploads[0]!.headers,
      body,
    });
    expect(response.status).toBe(200);

    const error = await failingFiles
      .complete({ uploadId: session.uploadId, parts: [] }, context)
      .catch((caught: unknown) => caught);
    expect(errorCode(error)).toBe('KNOWLEDGE_DEPENDENCY_UNAVAILABLE');
    const after = await repository.findObjectRef(session.uploadId, context);
    expect(after?.state).not.toBe('active');
    expect(after?.uploadStatus).toBe('completing');
    const finalError = await objectStore
      .headObject(objectStore.bucket, ref.finalObjectKey!, {
        workspaceId: context.workspaceId,
        knowledgeSpaceId,
        requestId: context.requestId,
        traceId: context.traceId,
      })
      .catch((caught: unknown) => caught);
    expect(errorCode(finalError)).toBe('KNOWLEDGE_NOT_FOUND');
  });

  it('TEST-FILE-001-U12 rejects a pre-existing final key with a different digest', async () => {
    const body = Buffer.from('expected final content');
    const { session, ref } = await putSingle(body.byteLength, 'final-conflict.txt', body);
    if (!ref.finalObjectKey) throw new Error('final key missing');
    const conflicting = Buffer.alloc(body.byteLength, 0x78);
    await objectStore.putObject(
      {
        key: ref.finalObjectKey,
        body: conflicting,
        sizeBytes: conflicting.byteLength,
        contentType: 'text/plain',
        workspaceId: context.workspaceId,
        knowledgeSpaceId,
      },
      {
        workspaceId: context.workspaceId,
        knowledgeSpaceId,
        requestId: context.requestId,
        traceId: context.traceId,
      },
    );
    createdObjects.add(ref.finalObjectKey);

    const error = await files
      .complete({ uploadId: session.uploadId, parts: [] }, context)
      .catch((caught: unknown) => caught);
    expect(errorCode(error)).toBe('KNOWLEDGE_CONFLICT');
    const after = await repository.findObjectRef(session.uploadId, context);
    expect(after?.state).not.toBe('active');
  });

  it('TEST-FILE-001-U13 / TEST-X-IMMUTABLE-UPLOAD commits active metadata only to a final key', async () => {
    const body = Buffer.from('immutable-key');
    const { session, ref } = await putSingle(body.byteLength, 'immutable.txt', body);
    const completed = await files.complete({ uploadId: session.uploadId, parts: [] }, context);
    expect(ref.finalObjectKey).not.toBeNull();
    expect(completed.objectKey).toBe(ref.finalObjectKey);
    expect(completed.objectKey).not.toBe(ref.objectKey);
    expect(completed.pendingObjectKey).toBe(ref.objectKey);
    expect(completed.finalizedAt).not.toBeNull();
  });

  it('TEST-FILE-001-U19 / TEST-X-IMMUTABLE-UPLOAD keeps the active final object unchanged after URL replay', async () => {
    const original = Buffer.from('immutable original content');
    const { session, presigned } = await putSingle(original.byteLength, 'replay.txt', original);
    const completed = await files.complete({ uploadId: session.uploadId, parts: [] }, context);
    const finalKey = completed.objectKey;
    const pendingKey = completed.pendingObjectKey;
    expect(pendingKey).not.toBeNull();
    expect(finalKey).not.toBe(pendingKey);

    const source = await connection.models.KnowledgeSource.create({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: new mongoose.Types.ObjectId(knowledgeSpaceId),
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      kind: 'file',
      name: 'replay.txt',
      blobRefId: new mongoose.Types.ObjectId(completed.blobId),
      mimeType: 'text/plain',
      sizeBytes: original.byteLength,
      ownershipMemberId: context.memberId,
    });
    await connection.models.KnowledgeObjectRef.updateOne(
      {
        workspaceId: context.workspaceId,
        _id: new mongoose.Types.ObjectId(completed.blobId),
      },
      { $set: { sourceId: source._id } },
    );
    const download = await files.download(completed.blobId, { ttlSeconds: 300 }, context);
    const ticket = new URL(download.url).searchParams.get('ticket');
    expect(ticket).not.toBeNull();

    const replay = await fetch(presigned.uploads[0]!.url, {
      method: 'PUT',
      headers: presigned.uploads[0]!.headers,
      body: Buffer.from('attacker replacement'),
    });
    expect(replay.status).toBe(200);

    const storage = {
      workspaceId: context.workspaceId,
      knowledgeSpaceId,
      requestId: context.requestId,
      traceId: context.traceId,
    };
    const pendingHead = await objectStore.headObject(objectStore.bucket, pendingKey!, storage);
    expect(pendingHead.size).toBe(Buffer.byteLength('attacker replacement'));
    const finalHead = await objectStore.headObject(objectStore.bucket, finalKey, storage);
    expect(finalHead.size).toBe(original.byteLength);
    expect(finalHead.etag).toBe(completed.etag);

    const finalObject = await objectStore.getObject(objectStore.bucket, finalKey, null, storage);
    const finalChunks: Buffer[] = [];
    for await (const chunk of finalObject.body) finalChunks.push(Buffer.from(chunk));
    expect(Buffer.concat(finalChunks)).toEqual(original);
    expect(createHash('sha256').update(Buffer.concat(finalChunks)).digest('hex')).toBe(
      completed.sha256,
    );

    const ticketed = await files.content(completed.blobId, null, ticket, {
      ...context,
      workspaceId: 'ticket',
      memberId: 'file-ticket',
    });
    const ticketChunks: Buffer[] = [];
    for await (const chunk of ticketed.body) ticketChunks.push(Buffer.from(chunk));
    expect(Buffer.concat(ticketChunks)).toEqual(original);
    deniedSources.add(String(source._id));
    const revokedTicket = await files
      .content(completed.blobId, null, ticket, {
        ...context,
        workspaceId: 'ticket',
        memberId: 'file-ticket',
      })
      .catch((error: unknown) => error);
    expect(errorCode(revokedTicket)).toBe('KNOWLEDGE_FORBIDDEN');
    expect(assertPermission).toHaveBeenCalled();
    deniedSources.delete(String(source._id));

    await connection.models.KnowledgeObjectRef.updateOne(
      {
        workspaceId: context.workspaceId,
        _id: new mongoose.Types.ObjectId(completed.blobId),
      },
      { $set: { 'upload.pendingUrlExpiresAt': new Date(Date.now() - 1) } },
    );
    await lifecycle.cleanup(context, new Date());

    const cleaned = await repository.findObjectRef(completed.blobId, context);
    expect(cleaned?.state).toBe('active');
    expect(cleaned?.objectKey).toBe(finalKey);
    expect(cleaned?.pendingObjectKey).toBeNull();
    const pendingError = await objectStore
      .headObject(objectStore.bucket, pendingKey!, storage)
      .catch((error: unknown) => error);
    expect(errorCode(pendingError)).toBe('KNOWLEDGE_NOT_FOUND');
    const activeHead = await objectStore.headObject(objectStore.bucket, finalKey, storage);
    expect(activeHead.etag).toBe(completed.etag);
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

  it('TEST-FILE-001-U21 accepts a valid ZIP container through real MinIO inspection', async () => {
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

  it('TEST-FILE-001-U14 rejects deflate padding through the real MinIO completion path', async () => {
    const content = Buffer.alloc(17 * 1024 * 1024);
    const deflated = deflateRawSync(content);
    const body = buildZip([
      {
        name: 'padded-bomb.txt',
        data: content,
        compressedSize: deflated.length + 300 * 1024,
      },
    ]);
    const session = await files.init(
      {
        knowledgeSpaceId,
        name: 'padded-bomb.zip',
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

  it('TEST-FILE-001-U23 fails closed when ZIP safety inspection is unavailable', async () => {
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

    const otherBody = Buffer.from('other source binding');
    const otherUpload = await putSingle(otherBody.byteLength, 'other.txt', otherBody);
    const otherCompleted = await files.complete(
      { uploadId: otherUpload.session.uploadId, parts: [] },
      context,
    );
    const otherSource = await connection.models.KnowledgeSource.create({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: new mongoose.Types.ObjectId(knowledgeSpaceId),
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      kind: 'file',
      name: 'other.txt',
      blobRefId: new mongoose.Types.ObjectId(otherCompleted.blobId),
      mimeType: 'text/plain',
      sizeBytes: otherBody.byteLength,
      ownershipMemberId: context.memberId,
    });
    await connection.models.KnowledgeObjectRef.updateOne(
      {
        workspaceId: context.workspaceId,
        _id: new mongoose.Types.ObjectId(otherCompleted.blobId),
      },
      { $set: { sourceId: otherSource._id } },
    );
    await connection.models.KnowledgeSource.updateOne(
      { workspaceId: context.workspaceId, _id: source._id },
      { $set: { blobRefId: otherSource.blobRefId } },
    );
    const mismatchedPreview = await sourceFiles
      .preview(String(source._id), context)
      .catch((caught: unknown) => caught);
    expect(errorCode(mismatchedPreview)).toBe('KNOWLEDGE_NOT_FOUND');
    const mismatchedDownload = await sourceFiles
      .download(String(source._id), context)
      .catch((caught: unknown) => caught);
    expect(errorCode(mismatchedDownload)).toBe('KNOWLEDGE_NOT_FOUND');
    await connection.models.KnowledgeSource.updateOne(
      { workspaceId: context.workspaceId, _id: source._id },
      { $set: { blobRefId: new mongoose.Types.ObjectId(completed.blobId) } },
    );

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

  it('TEST-MULTI-001-RR01 serves signed unbound query images only to their creator', async () => {
    const imageBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const { session } = await putSingle(
      imageBytes.byteLength,
      `query-${suffix}.png`,
      imageBytes,
      'image/png',
    );
    const completed = await files.complete({ uploadId: session.uploadId, parts: [] }, context);
    await connection.models.KnowledgeObjectRef.updateOne(
      {
        workspaceId: context.workspaceId,
        _id: new mongoose.Types.ObjectId(completed.blobId),
      },
      { $set: { purpose: 'image', sourceId: null } },
    );

    const tickets = new S8FileTicketAdapter(fileTickets);
    const issued = tickets.issueImage({
      workspaceId: context.workspaceId,
      blobId: completed.blobId,
      sourceId: null,
      knowledgeSpaceId,
      ttlSeconds: 300,
      context,
    });
    const ticket = new URL(issued.url).searchParams.get('ticket');
    expect(ticket).not.toBeNull();
    const content = await files.content(completed.blobId, null, ticket, {
      ...context,
      workspaceId: 'ticket',
      memberId: 'ticket-reader',
    });
    const chunks: Buffer[] = [];
    for await (const chunk of content.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(imageBytes);
    expect(content.contentType).toBe('image/png');

    const otherMember = fileTickets.issue(
      {
        workspaceId: context.workspaceId,
        memberId: `${context.memberId}_other`,
        isWorkspaceOwner: false,
        scopes: ['knowledge:read'],
        blobId: completed.blobId,
        sourceId: null,
        knowledgeSpaceId,
        disposition: 'inline',
        ttlSeconds: 300,
      },
      context.requestId,
      context.traceId,
    );
    const otherTicket = new URL(otherMember.url).searchParams.get('ticket');
    const denied = await files
      .content(completed.blobId, null, otherTicket, {
        ...context,
        workspaceId: 'ticket',
        memberId: 'ticket-reader',
      })
      .catch((error: unknown) => error);
    expect(errorCode(denied)).toBe('KNOWLEDGE_NOT_FOUND');
  });

  it('TEST-FILE-003-F08 returns 403 when Source ACL denies the same workspace member', async () => {
    const body = Buffer.from('denied source content');
    const { session } = await putSingle(body.byteLength, 'denied.txt', body);
    const completed = await files.complete({ uploadId: session.uploadId, parts: [] }, context);
    const source = await connection.models.KnowledgeSource.create({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: new mongoose.Types.ObjectId(knowledgeSpaceId),
      version: 1,
      deletedAt: null,
      createdByMemberId: context.memberId,
      updatedByMemberId: context.memberId,
      kind: 'file',
      name: 'denied.txt',
      blobRefId: new mongoose.Types.ObjectId(completed.blobId),
      mimeType: 'text/plain',
      sizeBytes: body.byteLength,
      ownershipMemberId: context.memberId,
    });
    await connection.models.KnowledgeObjectRef.updateOne(
      { workspaceId: context.workspaceId, _id: new mongoose.Types.ObjectId(completed.blobId) },
      { $set: { sourceId: source._id } },
    );
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
    const deniedAccess = {
      async assertPermission(resourceType: string) {
        if (resourceType === 'source') {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_FORBIDDEN',
            requestId: context.requestId,
            traceId: context.traceId,
          });
        }
        return { allowed: true };
      },
    } as unknown as AccessPort;
    const deniedSources = new SourceFileApplication(
      sourceCatalog,
      new KnowledgeArchiveRepository(connection),
      deniedAccess,
      repository,
      objectStore,
      fileTickets,
      new ObjectStoreArchiveSafetyAdapter(objectStore),
    );

    const previewError = await deniedSources
      .preview(String(source._id), context)
      .catch((caught: unknown) => caught);
    expect(errorCode(previewError)).toBe('KNOWLEDGE_FORBIDDEN');
    const downloadError = await deniedSources
      .download(String(source._id), context)
      .catch((caught: unknown) => caught);
    expect(errorCode(downloadError)).toBe('KNOWLEDGE_FORBIDDEN');
  });
});
