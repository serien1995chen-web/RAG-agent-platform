import { createHash } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';
import { Client } from 'minio';
import type {
  MultipartPartReceipt,
  MultipartPartUpload,
  ObjectRef,
  ObjectStorePort,
  TenantObjectContext,
} from '../interface';
import { assertObjectKeyScope, objectKeyHash } from '../tenant-scope';

/** 单次 multipart 上传允许的最大分片数（设计文档 7.6 / 12.6）。 */
const MAX_MULTIPART_PARTS = 10000;

export interface MinioObjectStoreConfig {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  region: string;
  bucket: string;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; statusCode?: unknown; status?: unknown };
  return (
    record.code === 'NoSuchKey' ||
    record.code === 'NotFound' ||
    record.statusCode === 404 ||
    record.status === 404
  );
}

function isNoSuchUpload(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { code?: unknown }).code === 'NoSuchUpload';
}

function normalizeEtag(value: string | null | undefined): string {
  return (value ?? '').replace(/^"|"$/g, '').toLowerCase();
}

/**
 * 校验分片 checksum，支持 `sha256:<hex>`、`md5:<hex>` 与裸 hex
 * （32 位按 md5、64 位按 sha256）；不匹配或格式非法返回 false。
 */
function checksumMatches(body: Uint8Array, checksum: string): boolean {
  const declared = checksum.trim().toLowerCase();
  if (declared.length === 0) return false;
  let algorithm = declared.length === 64 ? 'sha256' : 'md5';
  let hex = declared;
  const separator = declared.indexOf(':');
  if (separator >= 0) {
    algorithm = declared.slice(0, separator);
    hex = declared.slice(separator + 1);
  }
  if (algorithm === 'sha256') {
    return hex.length === 64 && createHash('sha256').update(body).digest('hex') === hex;
  }
  if (algorithm === 'md5') {
    return hex.length === 32 && createHash('md5').update(body).digest('hex') === hex;
  }
  return false;
}

/**
 * S3 兼容（MinIO）实现（设计文档 7.6 / 10.9.1）：
 * 真实读写 + 触网前租户前缀校验 + 统一错误映射（不泄露内部路径）。
 */
export class MinioObjectStore implements ObjectStorePort {
  private readonly client: Client;
  private readonly bucket: string;
  private readonly region: string;
  private bucketReady = false;

  constructor(config: MinioObjectStoreConfig) {
    this.bucket = config.bucket;
    this.region = config.region;
    this.client = new Client({
      endPoint: config.endPoint,
      port: config.port,
      useSSL: config.useSSL,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      region: config.region,
    });
  }

  private async mapErrors<T>(
    operation: string,
    work: () => Promise<T>,
    ref?: ObjectRef,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ApiErrorException) throw error;
      if (ref !== undefined && isNotFound(error)) {
        throw new ApiErrorException(
          createApiError({
            code: 501015,
            requestId: 'object-store',
            params: { objectKeyHash: objectKeyHash(ref.key), bucket: ref.bucket },
          }),
        );
      }
      throw new ApiErrorException(
        createApiError({
          code: 501016,
          requestId: 'object-store',
          params: { store: 's3', operation },
        }),
      );
    }
  }

  /** 完整性错误 501060：参数只含 fileId(=objectKeyHash) / uploadId / 缺失分片号，不泄露完整 key。 */
  private integrityError(
    uploadId: string,
    ref: ObjectRef,
    missingParts: readonly number[],
  ): ApiErrorException {
    return new ApiErrorException(
      createApiError({
        code: 501060,
        requestId: 'object-store',
        params: {
          fileId: objectKeyHash(ref.key),
          uploadId,
          missingParts: [...missingParts],
        },
      }),
    );
  }

  async ensureBucket(): Promise<void> {
    return this.mapErrors('ensureBucket', async () => {
      if (this.bucketReady) return;
      const exists = await this.client.bucketExists(this.bucket);
      if (!exists) await this.client.makeBucket(this.bucket, this.region);
      this.bucketReady = true;
    });
  }

  async put(
    input: { ref: ObjectRef; body: Uint8Array },
    context: TenantObjectContext,
  ): Promise<ObjectRef> {
    assertObjectKeyScope(input.ref, context);
    return this.mapErrors(
      'put',
      async () => {
        await this.ensureBucket();
        const buffer = Buffer.from(input.body);
        const result = await this.client.putObject(
          this.bucket,
          input.ref.key,
          buffer,
          buffer.byteLength,
        );
        return { ...input.ref, size: buffer.byteLength, etag: result.etag };
      },
      input.ref,
    );
  }

  async get(
    input: { ref: ObjectRef },
    context: TenantObjectContext,
  ): Promise<{ ref: ObjectRef; body: Uint8Array }> {
    assertObjectKeyScope(input.ref, context);
    return this.mapErrors(
      'get',
      async () => {
        const stream = await this.client.getObject(this.bucket, input.ref.key);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
        return { ref: input.ref, body: Buffer.concat(chunks) };
      },
      input.ref,
    );
  }

  async delete(
    input: { ref: ObjectRef },
    context: TenantObjectContext,
  ): Promise<{ deleted: boolean }> {
    assertObjectKeyScope(input.ref, context);
    return this.mapErrors(
      'delete',
      async () => {
        await this.client.removeObject(this.bucket, input.ref.key);
        return { deleted: true };
      },
      input.ref,
    );
  }

  async promote(input: { ref: ObjectRef }, context: TenantObjectContext): Promise<ObjectRef> {
    assertObjectKeyScope(input.ref, context);
    return this.mapErrors(
      'promote',
      async () => {
        // versionId 为空表示操作当前版本；清除 TTL 标记后正式引用不再因 TTL 删除。
        await this.client.removeObjectTagging(this.bucket, input.ref.key, { versionId: '' });
        return { ...input.ref, ttlExpireAt: null };
      },
      input.ref,
    );
  }

  async prepareMultipart(
    input: { ref: ObjectRef; parts: number },
    context: TenantObjectContext,
  ): Promise<ObjectRef> {
    assertObjectKeyScope(input.ref, context);
    return this.mapErrors(
      'prepareMultipart',
      async () => {
        await this.ensureBucket();
        const uploadId = await this.client.initiateNewMultipartUpload(
          this.bucket,
          input.ref.key,
          {},
        );
        return { ...input.ref, multipartUploadId: uploadId };
      },
      input.ref,
    );
  }

  async uploadPart(
    input: MultipartPartUpload,
    context: TenantObjectContext,
  ): Promise<MultipartPartReceipt> {
    assertObjectKeyScope(input.ref, context);
    return this.mapErrors(
      'uploadPart',
      async () => {
        await this.ensureBucket();
        if (
          !input.uploadId ||
          !Number.isInteger(input.partNumber) ||
          input.partNumber < 1 ||
          input.partNumber > MAX_MULTIPART_PARTS
        ) {
          throw this.integrityError(input.uploadId, input.ref, [input.partNumber]);
        }
        const body = Buffer.from(input.body);
        if (!checksumMatches(body, input.checksum)) {
          throw this.integrityError(input.uploadId, input.ref, [input.partNumber]);
        }
        let etag: string;
        try {
          const result = await this.client.uploadPart(
            {
              bucketName: this.bucket,
              objectName: input.ref.key,
              uploadID: input.uploadId,
              partNumber: input.partNumber,
              headers: {},
            },
            body,
          );
          etag = normalizeEtag(result.etag);
        } catch (error) {
          if (isNoSuchUpload(error)) {
            throw this.integrityError(input.uploadId, input.ref, [input.partNumber]);
          }
          throw error;
        }
        return { partNumber: input.partNumber, etag, size: body.byteLength };
      },
      input.ref,
    );
  }

  async completeMultipart(
    input: {
      ref: ObjectRef;
      uploadId: string;
      parts: readonly MultipartPartReceipt[];
      hash: string;
    },
    context: TenantObjectContext,
  ): Promise<ObjectRef> {
    assertObjectKeyScope(input.ref, context);
    return this.mapErrors(
      'completeMultipart',
      async () => {
        if (!input.uploadId) {
          throw this.integrityError('', input.ref, []);
        }
        if (input.parts.length < 1 || input.parts.length > MAX_MULTIPART_PARTS) {
          throw this.integrityError(
            input.uploadId,
            input.ref,
            input.parts.map((part) => part.partNumber),
          );
        }
        const seen = new Set<number>();
        const invalid: number[] = [];
        for (const part of input.parts) {
          if (
            !Number.isInteger(part.partNumber) ||
            part.partNumber < 1 ||
            part.partNumber > MAX_MULTIPART_PARTS ||
            !part.etag ||
            seen.has(part.partNumber)
          ) {
            invalid.push(part.partNumber);
            continue;
          }
          seen.add(part.partNumber);
        }
        if (invalid.length > 0) {
          throw this.integrityError(input.uploadId, input.ref, invalid);
        }
        const ordered = [...input.parts].sort((a, b) => a.partNumber - b.partNumber);
        let etag: string;
        try {
          const result = await this.client.completeMultipartUpload(
            this.bucket,
            input.ref.key,
            input.uploadId,
            ordered.map((part) => ({ part: part.partNumber, etag: part.etag })),
          );
          etag = normalizeEtag(result.etag);
        } catch (error) {
          if (isNoSuchUpload(error)) {
            throw this.integrityError(input.uploadId, input.ref, []);
          }
          throw error;
        }
        if (normalizeEtag(input.hash) !== etag) {
          throw this.integrityError(input.uploadId, input.ref, []);
        }
        const size = ordered.reduce((total, part) => total + part.size, 0);
        return { ...input.ref, size, etag, multipartUploadId: undefined };
      },
      input.ref,
    );
  }

  async abort(
    input: { ref: ObjectRef },
    context: TenantObjectContext,
  ): Promise<{ aborted: boolean }> {
    assertObjectKeyScope(input.ref, context);
    return this.mapErrors(
      'abort',
      async () => {
        try {
          await this.client.removeIncompleteUpload(this.bucket, input.ref.key);
        } catch (error) {
          // 幂等清理：没有待中止的分片上传时视为已完成。
          if (!isNoSuchUpload(error)) throw error;
        }
        return { aborted: true };
      },
      input.ref,
    );
  }
}
