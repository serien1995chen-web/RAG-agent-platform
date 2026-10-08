import { ApiErrorException, createApiError } from '@kb/contracts';
import { Client } from 'minio';
import type { ObjectRef, ObjectStorePort, TenantObjectContext } from '../interface';
import { assertObjectKeyScope, objectKeyHash } from '../tenant-scope';

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
