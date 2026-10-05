import { Client } from 'minio';
import type { ObjectRef, ObjectStorePort, TenantObjectContext } from '../interface';
import { assertObjectKeyScope } from '../tenant-scope';

export interface MinioObjectStoreConfig {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  region: string;
  bucket: string;
}

/** S3 兼容（MinIO）实现骨架：真实读写 + 租户前缀校验。 */
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

  async ensureBucket(): Promise<void> {
    if (this.bucketReady) return;
    const exists = await this.client.bucketExists(this.bucket);
    if (!exists) await this.client.makeBucket(this.bucket, this.region);
    this.bucketReady = true;
  }

  async put(
    input: { ref: ObjectRef; body: Uint8Array },
    context: TenantObjectContext,
  ): Promise<ObjectRef> {
    assertObjectKeyScope(input.ref, context);
    await this.ensureBucket();
    const buffer = Buffer.from(input.body);
    const result = await this.client.putObject(
      this.bucket,
      input.ref.key,
      buffer,
      buffer.byteLength,
    );
    return { ...input.ref, size: buffer.byteLength, etag: result.etag };
  }

  async get(
    input: { ref: ObjectRef },
    context: TenantObjectContext,
  ): Promise<{ ref: ObjectRef; body: Uint8Array }> {
    assertObjectKeyScope(input.ref, context);
    const stream = await this.client.getObject(this.bucket, input.ref.key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    return { ref: input.ref, body: Buffer.concat(chunks) };
  }

  async delete(
    input: { ref: ObjectRef },
    context: TenantObjectContext,
  ): Promise<{ deleted: boolean }> {
    assertObjectKeyScope(input.ref, context);
    await this.client.removeObject(this.bucket, input.ref.key);
    return { deleted: true };
  }

  async promote(input: { ref: ObjectRef }, context: TenantObjectContext): Promise<ObjectRef> {
    assertObjectKeyScope(input.ref, context);
    // versionId 为空表示操作当前版本（MinIO 8 typings 要求显式传入）。
    await this.client.removeObjectTagging(this.bucket, input.ref.key, { versionId: '' });
    return { ...input.ref, ttlExpireAt: null };
  }

  async prepareMultipart(
    input: { ref: ObjectRef; parts: number },
    context: TenantObjectContext,
  ): Promise<ObjectRef> {
    assertObjectKeyScope(input.ref, context);
    await this.ensureBucket();
    const uploadId = await this.client.initiateNewMultipartUpload(this.bucket, input.ref.key, {});
    return { ...input.ref, multipartUploadId: uploadId };
  }

  async abort(
    input: { ref: ObjectRef },
    context: TenantObjectContext,
  ): Promise<{ aborted: boolean }> {
    assertObjectKeyScope(input.ref, context);
    await this.client.removeIncompleteUpload(this.bucket, input.ref.key);
    return { aborted: true };
  }
}
