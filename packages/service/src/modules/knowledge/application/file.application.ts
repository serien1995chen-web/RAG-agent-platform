import { createHash, randomBytes } from 'node:crypto';
import { KnowledgeApiError, createKnowledgeError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type {
  AccessPort,
  ArchiveSafetyPort,
  ArchiveSafetyResult,
  CatalogPort,
  FileBinaryResult,
  FileTicketDisposition,
  FileTicketPort,
  ObjectRefRepositoryPort,
  ObjectRefView,
  ObjectStorageContext,
  ObjectStoreApplicationPort,
  UploadPartView,
  UploadSessionView,
} from './ports';

export const UPLOAD_PART_SIZE_BYTES = 8 * 1024 * 1024;
export const UPLOAD_MAX_PARTS = 10_000;
export const UPLOAD_MAX_BYTES = 1_000 * 1024 * 1024;
export const UPLOAD_SESSION_TTL_MS = 3 * 60 * 60 * 1000;

const MIME_BY_EXTENSION: Record<string, readonly string[]> = {
  txt: ['text/plain'],
  md: ['text/markdown', 'text/x-markdown'],
  markdown: ['text/markdown', 'text/x-markdown'],
  html: ['text/html', 'application/xhtml+xml'],
  htm: ['text/html', 'application/xhtml+xml'],
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  csv: ['text/csv', 'application/csv'],
  epub: ['application/epub+zip'],
  zip: ['application/zip'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  webp: ['image/webp'],
  gif: ['image/gif'],
  tif: ['image/tiff'],
  tiff: ['image/tiff'],
};

export interface UploadInitInput {
  knowledgeSpaceId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface UploadPresignInput {
  partNumbers: number[];
}

export interface UploadCompleteInput {
  uploadId: string;
  parts: Array<{ partNumber: number; etag: string }>;
  version?: number;
}

export interface FileTicketRequestInput {
  ttlSeconds?: number;
  disposition?: FileTicketDisposition;
}

function validationError(context: TenantContext, field: string, reason: string) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_VALIDATION_FAILED',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { field, reason },
  });
}

function payloadError(context: TenantContext, limit: string) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { limit },
  });
}

function notFound(context: TenantContext) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_NOT_FOUND',
    requestId: context.requestId,
    traceId: context.traceId,
  });
}

function conflict(context: TenantContext, details: Record<string, unknown>) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_CONFLICT',
    requestId: context.requestId,
    traceId: context.traceId,
    details,
  });
}

function unsupported(context: TenantContext, details: Record<string, unknown>) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_UNSUPPORTED_CONTENT',
    requestId: context.requestId,
    traceId: context.traceId,
    details,
  });
}

function providerContractFailure(context: TenantContext, operation: string) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { operation },
  });
}

function normalizeMime(value: string): string {
  return value.split(';')[0]?.trim().toLowerCase() ?? '';
}

function safeName(value: string): string {
  const base = value.replaceAll('\\', '/').split('/').pop() ?? '';
  const withoutControls = [...base].filter((character) => character.charCodeAt(0) >= 32).join('');
  const normalized = withoutControls.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return (normalized || 'upload').slice(0, 180);
}

function storageContext(context: TenantContext, knowledgeSpaceId: string): ObjectStorageContext {
  return {
    workspaceId: context.workspaceId,
    knowledgeSpaceId,
    requestId: context.requestId,
    traceId: context.traceId,
  };
}

function uploadObjectKeys(
  context: TenantContext,
  knowledgeSpaceId: string,
  uploadId: string,
  name: string,
): { pendingKey: string; finalKey: string } {
  const prefix = [
    'ws',
    safeName(context.workspaceId),
    'space',
    safeName(knowledgeSpaceId),
    'source',
    'unbound',
  ];
  return {
    pendingKey: [...prefix, 'pending', uploadId, name].join('/'),
    finalKey: [...prefix, 'source', uploadId, name].join('/'),
  };
}

function extensionOf(name: string): string {
  const leaf = name.toLowerCase();
  const index = leaf.lastIndexOf('.');
  return index < 0 ? '' : leaf.slice(index + 1);
}

function validateNameAndMime(name: string, mimeType: string, context: TenantContext): void {
  const extension = extensionOf(name);
  const allowedMimes = MIME_BY_EXTENSION[extension];
  if (!allowedMimes) {
    throw unsupported(context, { name, mimeType, reason: 'unsupported_mime_or_extension' });
  }
  if (!allowedMimes.includes(mimeType)) {
    throw unsupported(context, {
      name,
      mimeType,
      reason: 'extension_mime_mismatch',
    });
  }
}

function magicMatches(mimeType: string, bytes: Uint8Array): boolean {
  const buffer = Buffer.from(bytes);
  const zipMagic =
    buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
    buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06])) ||
    buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
  switch (mimeType) {
    case 'application/pdf':
      return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
    case 'image/png':
      return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'image/jpeg':
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case 'image/gif':
      return (
        buffer.subarray(0, 6).toString('ascii') === 'GIF89a' ||
        buffer.subarray(0, 6).toString('ascii') === 'GIF87a'
      );
    case 'image/webp':
      return (
        buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buffer.subarray(8, 12).toString('ascii') === 'WEBP'
      );
    case 'image/tiff':
      return (
        buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
        buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))
      );
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return zipMagic;
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return zipMagic;
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return zipMagic;
    case 'application/epub+zip':
    case 'application/zip':
      return zipMagic;
    default:
      return true;
  }
}

function isZipContainer(mimeType: string): boolean {
  return (
    mimeType === 'application/zip' ||
    mimeType === 'application/epub+zip' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
}

function archiveSafetyProblem(result: ArchiveSafetyResult, context: TenantContext) {
  if (result.status === 'too_large') {
    return payloadError(context, result.reason ?? 'archive limits exceeded');
  }
  if (result.status === 'dependency_timeout') {
    return createKnowledgeError({
      code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { operation: 'archiveSafety' },
    });
  }
  if (result.status === 'dependency_unavailable') {
    return createKnowledgeError({
      code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
      requestId: context.requestId,
      traceId: context.traceId,
      details: { operation: 'archiveSafety' },
    });
  }
  return unsupported(context, { reason: result.reason ?? 'archive_safety_rejected' });
}

async function hashObject(
  stream: AsyncIterable<Uint8Array>,
): Promise<{ sha256: string; prefix: Buffer }> {
  const hash = createHash('sha256');
  const prefixChunks: Buffer[] = [];
  let prefixSize = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    hash.update(buffer);
    if (prefixSize < 4096) {
      const remaining = 4096 - prefixSize;
      prefixChunks.push(buffer.subarray(0, Math.min(remaining, buffer.byteLength)));
      prefixSize += Math.min(remaining, buffer.byteLength);
    }
  }
  return { sha256: hash.digest('hex'), prefix: Buffer.concat(prefixChunks) };
}

export class FileApplication {
  constructor(
    private readonly objectRefs: ObjectRefRepositoryPort,
    private readonly objectStore: ObjectStoreApplicationPort,
    private readonly catalog: CatalogPort,
    private readonly access: AccessPort,
    private readonly tickets?: FileTicketPort,
    private readonly archiveSafety?: ArchiveSafetyPort,
  ) {}

  private async session(uploadId: string, context: TenantContext): Promise<UploadSessionView> {
    const session = await this.objectRefs.findUploadSession(uploadId, context);
    if (!session) throw notFound(context);
    return session;
  }

  private async ensureOpen(session: UploadSessionView, context: TenantContext): Promise<void> {
    if (Date.parse(session.expiresAt) <= Date.now()) {
      await this.objectRefs.markUploadExpired(session.uploadId, context);
      throw conflict(context, { uploadId: session.uploadId, status: 'expired' });
    }
    if (session.status !== 'uploading' && session.status !== 'pending') {
      throw conflict(context, { uploadId: session.uploadId, status: session.status });
    }
  }

  async init(input: UploadInitInput, context: TenantContext): Promise<UploadSessionView> {
    const name = safeName(input.name);
    const mimeType = normalizeMime(input.mimeType);
    validateNameAndMime(name, mimeType, context);
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
      throw payloadError(context, 'sizeBytes must be greater than zero');
    }
    if (input.sizeBytes > UPLOAD_MAX_BYTES) throw payloadError(context, '1000 MiB');
    const partCount = Math.ceil(input.sizeBytes / UPLOAD_PART_SIZE_BYTES);
    if (partCount > UPLOAD_MAX_PARTS) throw payloadError(context, '10000 parts');

    await this.catalog.getSpace(input.knowledgeSpaceId, context);
    await this.access.assertPermission('space', input.knowledgeSpaceId, 'write', context);

    const uploadId = randomBytes(12).toString('hex');
    const mode = input.sizeBytes <= UPLOAD_PART_SIZE_BYTES ? 'single' : 'multipart';
    const { pendingKey: key, finalKey } = uploadObjectKeys(
      context,
      input.knowledgeSpaceId,
      uploadId,
      name,
    );
    const storage = storageContext(context, input.knowledgeSpaceId);
    await this.objectStore.ensureBucket(this.objectStore.bucket, storage);
    const providerUploadId =
      mode === 'multipart'
        ? await this.objectStore.createMultipartUpload(key, mimeType, {}, storage)
        : null;
    return this.objectRefs.createUploadSession(
      {
        uploadId,
        workspaceId: context.workspaceId,
        knowledgeSpaceId: input.knowledgeSpaceId,
        provider: this.objectStore.provider,
        bucket: this.objectStore.bucket,
        objectKey: key,
        finalObjectKey: finalKey,
        mimeType,
        sizeBytes: input.sizeBytes,
        originalName: name,
        mode,
        partSizeBytes: UPLOAD_PART_SIZE_BYTES,
        partCount,
        providerUploadId,
        expiresAt: new Date(Date.now() + UPLOAD_SESSION_TTL_MS),
      },
      context,
    );
  }

  async presign(
    uploadId: string,
    input: UploadPresignInput,
    context: TenantContext,
  ): Promise<{
    uploads: Array<{
      partNumber: number;
      method: 'PUT';
      url: string;
      headers: Record<string, string>;
      expiresAt: string;
    }>;
  }> {
    const session = await this.session(uploadId, context);
    await this.ensureOpen(session, context);
    const numbers = [...new Set(input.partNumbers)];
    if (numbers.length !== input.partNumbers.length || numbers.length === 0) {
      throw validationError(context, 'partNumbers', 'must_be_nonempty_and_unique');
    }
    if (numbers.some((number) => !Number.isInteger(number) || number < 1)) {
      throw validationError(context, 'partNumbers', 'out_of_range');
    }
    if (numbers.some((number) => number > UPLOAD_MAX_PARTS)) {
      throw payloadError(context, '10000 parts');
    }
    if (session.mode === 'single' && (numbers.length !== 1 || numbers[0] !== 1)) {
      throw validationError(context, 'partNumbers', 'single_mode_only_part_1');
    }
    if (session.mode === 'multipart' && numbers.some((number) => number > session.partCount)) {
      throw payloadError(context, 'partCount');
    }
    const ref = await this.objectRefs.findObjectRef(uploadId, context);
    if (!ref) throw notFound(context);
    const storage = storageContext(context, ref.knowledgeSpaceId);
    const expiresSeconds = Math.max(
      1,
      Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000),
    );
    const uploads = [];
    for (const partNumber of numbers) {
      if (session.mode === 'multipart' && !ref.providerUploadId) {
        throw conflict(context, { uploadId, reason: 'provider_upload_id_unavailable' });
      }
      const signed = await this.objectStore.presignPut(
        ref.objectKey,
        ref.mimeType,
        expiresSeconds,
        storage,
        session.mode === 'multipart'
          ? {
              providerUploadId: ref.providerUploadId ?? '',
              partNumber,
            }
          : undefined,
      );
      uploads.push({
        partNumber,
        method: signed.method,
        url: signed.url,
        headers: signed.headers,
        expiresAt: signed.expiresAt,
      });
    }
    return { uploads };
  }

  async uploadPart(
    uploadId: string,
    partNumber: number,
    body: Uint8Array,
    context: TenantContext,
  ): Promise<{ uploadId: string; partNumber: number; etag: string }> {
    const session = await this.session(uploadId, context);
    await this.ensureOpen(session, context);
    if (session.mode !== 'multipart') {
      throw conflict(context, { uploadId, reason: 'single_mode_has_no_parts' });
    }
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > session.partCount) {
      throw payloadError(context, 'partNumber');
    }
    const expectedSize =
      partNumber === session.partCount
        ? (await this.sessionSize(uploadId, context)) -
          (session.partCount - 1) * UPLOAD_PART_SIZE_BYTES
        : UPLOAD_PART_SIZE_BYTES;
    if (body.byteLength === 0 || body.byteLength > UPLOAD_PART_SIZE_BYTES) {
      throw payloadError(context, '8 MiB part');
    }
    if (body.byteLength !== expectedSize) {
      throw validationError(context, 'body', 'part_size_mismatch');
    }
    const ref = await this.objectRefs.findObjectRef(uploadId, context);
    if (!ref) throw notFound(context);
    if (!ref.providerUploadId) {
      throw conflict(context, { uploadId, reason: 'provider_upload_id_unavailable' });
    }
    const providerUploadId = ref.providerUploadId;
    const part = await this.objectStore.uploadPart(
      ref.objectKey,
      providerUploadId,
      partNumber,
      body,
      storageContext(context, ref.knowledgeSpaceId),
    );
    await this.objectRefs.recordUploadPart(uploadId, session.version, part, context);
    return { uploadId, partNumber, etag: part.etag };
  }

  async complete(input: UploadCompleteInput, context: TenantContext): Promise<ObjectRefView> {
    let session = await this.session(input.uploadId, context);
    if (session.status === 'completed') {
      const completed = await this.objectRefs.findObjectRef(input.uploadId, context);
      if (!completed) throw notFound(context);
      return completed;
    }
    if (session.status !== 'completing') {
      await this.ensureOpen(session, context);
    }
    if (
      input.parts.some(
        (part) =>
          !Number.isInteger(part.partNumber) ||
          part.partNumber < 1 ||
          part.partNumber > session.partCount ||
          part.etag.length === 0,
      ) ||
      new Set(input.parts.map((part) => part.partNumber)).size !== input.parts.length
    ) {
      throw validationError(context, 'parts', 'invalid_or_duplicate');
    }
    if (session.mode === 'multipart' && input.parts.length !== session.partCount) {
      throw validationError(context, 'parts', 'part_count_mismatch');
    }
    const ref = await this.objectRefs.findObjectRef(input.uploadId, context);
    if (!ref) throw notFound(context);
    const storage = storageContext(context, ref.knowledgeSpaceId);

    let providerParts: UploadPartView[] = [];
    let providerAlreadyCompleted = false;
    if (session.mode === 'multipart') {
      try {
        const existingHead = await this.objectStore.headObject(
          this.objectStore.bucket,
          ref.objectKey,
          storage,
        );
        providerAlreadyCompleted = existingHead.size === ref.sizeBytes;
        providerParts = session.parts;
      } catch (error) {
        if (
          !(error instanceof KnowledgeApiError) ||
          error.problem.error.code !== 'KNOWLEDGE_NOT_FOUND'
        ) {
          throw error;
        }
      }
      if (!providerAlreadyCompleted) {
        const providerUploadId = await this.providerUploadId(input.uploadId, context);
        providerParts = await this.objectStore.listParts(ref.objectKey, providerUploadId, storage);
        if (
          providerParts.length !== session.partCount ||
          providerParts.some((part) => part.partNumber < 1 || part.partNumber > session.partCount)
        ) {
          throw conflict(context, {
            uploadId: input.uploadId,
            reason: 'provider_parts_incomplete',
          });
        }
      }
    }

    try {
      if (session.status === 'uploading') {
        session = await this.objectRefs.markUploadCompleting(
          input.uploadId,
          session.version,
          context,
        );
      }
    } catch (error) {
      const completed = await this.objectRefs.findObjectRef(input.uploadId, context);
      if (completed?.state === 'active') return completed;
      throw error;
    }

    try {
      if (session.mode === 'multipart' && !providerAlreadyCompleted) {
        const providerUploadId = await this.providerUploadId(input.uploadId, context);
        await this.objectStore.completeMultipartUpload(
          ref.objectKey,
          providerUploadId,
          providerParts,
          storage,
        );
      }
      const head = await this.objectStore.headObject(
        this.objectStore.bucket,
        ref.objectKey,
        storage,
      );
      if (head.size !== ref.sizeBytes) {
        await this.objectStore.deleteObject(ref.objectKey, storage);
        await this.objectRefs
          .markUploadAborted(input.uploadId, session.version, context)
          .catch(() => undefined);
        if (head.size > ref.sizeBytes) {
          throw payloadError(context, 'declared sizeBytes');
        }
        throw unsupported(context, {
          reason: 'size_mismatch',
          declaredSizeBytes: ref.sizeBytes,
          actualSizeBytes: head.size,
        });
      }
      const object = await this.objectStore.getObject(
        this.objectStore.bucket,
        ref.objectKey,
        null,
        storage,
      );
      const hashed = await hashObject(object.body);
      if (!magicMatches(ref.mimeType, hashed.prefix)) {
        await this.objectStore.deleteObject(ref.objectKey, storage);
        await this.objectRefs
          .markUploadAborted(input.uploadId, session.version, context)
          .catch(() => undefined);
        throw unsupported(context, { reason: 'magic_mime_mismatch' });
      }
      if (isZipContainer(ref.mimeType)) {
        if (!this.archiveSafety) {
          await this.objectStore.deleteObject(ref.objectKey, storage).catch(() => undefined);
          await this.objectRefs
            .markUploadAborted(input.uploadId, session.version, context)
            .catch(() => undefined);
          throw createKnowledgeError({
            code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { reason: 'archive_safety_missing' },
          });
        }
        const inspected = await this.archiveSafety.inspect({
          kind: 'upload',
          bucket: this.objectStore.bucket,
          objectKey: ref.objectKey,
          sizeBytes: head.size,
          mimeType: ref.mimeType,
          originalName: ref.originalName,
          storage,
        });
        if (!inspected.archive || !inspected.safe) {
          await this.objectStore.deleteObject(ref.objectKey, storage).catch(() => undefined);
          await this.objectRefs
            .markUploadAborted(input.uploadId, session.version, context)
            .catch(() => undefined);
          throw archiveSafetyProblem(inspected, context);
        }
      }
      const stableHead = await this.objectStore.headObject(
        this.objectStore.bucket,
        ref.objectKey,
        storage,
      );
      if (stableHead.size !== head.size || stableHead.etag !== head.etag) {
        throw conflict(context, {
          uploadId: input.uploadId,
          reason: 'source_changed_during_validation',
        });
      }
      const finalKey = ref.finalObjectKey;
      if (!finalKey || finalKey === ref.objectKey) {
        throw conflict(context, {
          uploadId: input.uploadId,
          reason: 'immutable_target_unavailable',
        });
      }
      let finalHead: { size: number; etag: string } | null = null;
      try {
        finalHead = await this.objectStore.headObject(this.objectStore.bucket, finalKey, storage);
      } catch (error) {
        if (
          !(error instanceof KnowledgeApiError) ||
          error.problem.error.code !== 'KNOWLEDGE_NOT_FOUND'
        ) {
          throw error;
        }
      }
      const finalHeadPreExisted = finalHead !== null;
      if (finalHead) {
        if (finalHead.size !== head.size) {
          throw conflict(context, {
            uploadId: input.uploadId,
            reason: 'immutable_target_conflict',
          });
        }
      } else {
        const copied = await this.objectStore.copyObjectImmutable(
          {
            sourceKey: ref.objectKey,
            targetKey: finalKey,
            expectedSourceEtag: stableHead.etag,
            expectedSize: stableHead.size,
            contentType: ref.mimeType,
            metadata: { sha256: hashed.sha256 },
          },
          storage,
        );
        finalHead = await this.objectStore.headObject(this.objectStore.bucket, finalKey, storage);
        if (finalHead.size !== copied.sizeBytes || finalHead.etag !== copied.etag) {
          throw providerContractFailure(context, 'copyObjectImmutable');
        }
      }
      const finalObject = await this.objectStore.getObject(
        this.objectStore.bucket,
        finalKey,
        null,
        storage,
      );
      const finalHashed = await hashObject(finalObject.body);
      if (finalObject.size !== finalHead.size) {
        throw providerContractFailure(context, 'immutableFinalVerification');
      }
      if (finalHashed.sha256 !== hashed.sha256) {
        if (finalHeadPreExisted) {
          throw conflict(context, {
            uploadId: input.uploadId,
            reason: 'immutable_target_digest_conflict',
          });
        }
        throw providerContractFailure(context, 'immutableFinalVerification');
      }
      return await this.objectRefs.completeUpload(
        {
          uploadId: input.uploadId,
          expectedVersion: session.version,
          objectKey: finalKey,
          etag: finalHead.etag,
          sha256: finalHashed.sha256,
          sizeBytes: finalObject.size,
          parts: providerParts,
        },
        context,
      );
    } catch (error) {
      if (error instanceof KnowledgeApiError) throw error;
      throw createKnowledgeError({
        code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { operation: 'completeUploadCompensation' },
      });
    }
  }

  async abort(
    uploadId: string,
    version: number,
    context: TenantContext,
  ): Promise<{ id: string; status: 'accepted'; jobId: null }> {
    const session = await this.session(uploadId, context);
    const ref = await this.objectRefs.findObjectRef(uploadId, context);
    if (!ref) throw notFound(context);
    const storage = storageContext(context, ref.knowledgeSpaceId);
    await this.objectRefs.markUploadAborted(uploadId, version, context);
    if (session.mode === 'multipart') {
      const providerUploadId = await this.providerUploadId(uploadId, context);
      await this.objectStore.abortMultipartUpload(ref.objectKey, providerUploadId, storage);
    }
    return { id: uploadId, status: 'accepted', jobId: null };
  }

  async get(uploadId: string, context: TenantContext): Promise<UploadSessionView> {
    const session = await this.session(uploadId, context);
    if (
      (session.status === 'pending' || session.status === 'uploading') &&
      Date.parse(session.expiresAt) <= Date.now()
    ) {
      return this.objectRefs.markUploadExpired(uploadId, context);
    }
    return session;
  }

  private async assertFileReadable(ref: ObjectRefView, context: TenantContext): Promise<void> {
    if (ref.state !== 'active') throw notFound(context);
    if (ref.sourceId) {
      await this.access.assertPermission('source', ref.sourceId, 'read', context);
      return;
    }
    if (ref.purpose === 'export' && ref.knowledgeSpaceId) {
      await this.access.assertPermission('space', ref.knowledgeSpaceId, 'read', context);
      return;
    }
    throw notFound(context);
  }

  private async ticketFor(
    blobId: string,
    disposition: FileTicketDisposition,
    ttlSeconds: number,
    context: TenantContext,
  ): Promise<{ url: string; expiresAt: string }> {
    if (!this.tickets) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_INTERNAL_ERROR',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'file_ticket_service_missing' },
      });
    }
    const ref = await this.objectRefs.findObjectRef(blobId, context);
    if (!ref) throw notFound(context);
    await this.assertFileReadable(ref, context);
    const issued = this.tickets.issue(
      {
        workspaceId: ref.workspaceId,
        memberId: context.memberId,
        isWorkspaceOwner: context.isWorkspaceOwner === true,
        scopes: [...context.scopes],
        blobId: ref.blobId,
        sourceId: ref.sourceId,
        knowledgeSpaceId:
          ref.sourceId === null && ref.purpose === 'export' ? ref.knowledgeSpaceId : null,
        disposition,
        ttlSeconds,
      },
      context.requestId,
      context.traceId,
    );
    return { url: issued.url, expiresAt: issued.expiresAt };
  }

  async preview(
    blobId: string,
    input: FileTicketRequestInput,
    context: TenantContext,
  ): Promise<{
    ticketId: string;
    url: string;
    disposition: 'inline';
    expiresAt: string;
  }> {
    const ttlSeconds = input.ttlSeconds ?? 300;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600) {
      throw validationError(context, 'ttlSeconds', 'preview_ttl_60_3600');
    }
    const ticket = await this.ticketFor(blobId, 'inline', ttlSeconds, context);
    return {
      ...ticket,
      ticketId: createHash('sha256').update(ticket.url).digest('hex').slice(0, 24),
      disposition: 'inline',
    };
  }

  async download(
    blobId: string,
    input: FileTicketRequestInput,
    context: TenantContext,
  ): Promise<{
    ticketId: string;
    url: string;
    disposition: 'attachment';
    expiresAt: string;
  }> {
    const ttlSeconds = input.ttlSeconds ?? 300;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300) {
      throw validationError(context, 'ttlSeconds', 'download_ttl_max_300');
    }
    const ticket = await this.ticketFor(blobId, 'attachment', ttlSeconds, context);
    return {
      ...ticket,
      ticketId: createHash('sha256').update(ticket.url).digest('hex').slice(0, 24),
      disposition: 'attachment',
    };
  }

  async content(
    blobId: string,
    range: string | null,
    ticket: string | null,
    context: TenantContext,
  ): Promise<FileBinaryResult> {
    let effectiveContext = context;
    let disposition: FileTicketDisposition = 'inline';
    let claims: ReturnType<FileTicketPort['verify']> | null = null;
    if (ticket) {
      if (!this.tickets) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_INTERNAL_ERROR',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { reason: 'file_ticket_service_missing' },
        });
      }
      claims = this.tickets.verify(ticket, context.requestId, context.traceId);
      if (
        claims.blobId !== blobId ||
        (context.workspaceId !== 'ticket' && claims.workspaceId !== context.workspaceId)
      ) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_FORBIDDEN',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { reason: 'ticket_scope_mismatch' },
        });
      }
      effectiveContext = {
        ...context,
        workspaceId: claims.workspaceId,
        memberId: claims.memberId,
        isWorkspaceOwner: claims.isWorkspaceOwner,
        scopes: [...claims.scopes],
      };
      disposition = claims.disposition;
    }
    const ref = await this.objectRefs.findObjectRef(blobId, effectiveContext);
    if (!ref) throw notFound(effectiveContext);
    if (ticket) {
      if (!claims) throw notFound(effectiveContext);
      if (claims.workspaceId !== ref.workspaceId) throw notFound(effectiveContext);
      if (claims.sourceId !== ref.sourceId) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_FORBIDDEN',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { reason: 'ticket_source_binding_mismatch' },
        });
      }
      if (claims.knowledgeSpaceId !== null && claims.knowledgeSpaceId !== ref.knowledgeSpaceId) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_FORBIDDEN',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { reason: 'ticket_space_binding_mismatch' },
        });
      }
    }
    await this.assertFileReadable(ref, effectiveContext);
    const object = await this.objectStore.getObject(
      this.objectStore.bucket,
      ref.objectKey,
      range,
      storageContext(effectiveContext, ref.knowledgeSpaceId),
    );
    return {
      body: object.body,
      size: object.size,
      etag: object.etag,
      contentType: object.contentType ?? ref.mimeType,
      contentRange: object.contentRange,
      disposition,
      filename: ref.originalName,
    };
  }

  private async sessionSize(uploadId: string, context: TenantContext): Promise<number> {
    const ref = await this.objectRefs.findObjectRef(uploadId, context);
    if (!ref) throw notFound(context);
    return ref.sizeBytes;
  }

  private async providerUploadId(uploadId: string, context: TenantContext): Promise<string> {
    const ref = await this.objectRefs.findObjectRef(uploadId, context);
    if (!ref) throw notFound(context);
    if (!ref.providerUploadId) {
      throw conflict(context, { uploadId, reason: 'provider_upload_id_unavailable' });
    }
    return ref.providerUploadId;
  }
}
