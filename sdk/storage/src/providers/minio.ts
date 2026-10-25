import { Readable } from 'node:stream';
import { Client } from 'minio';
import type {
  KnowledgeObjectContext,
  KnowledgeObjectRef,
  MinioKnowledgeObjectStoreConfig,
  MultipartCompleteResult,
  MultipartPart,
  ObjectHeadResult,
  ObjectPutInput,
  ObjectStorePort,
  ObjectStreamResult,
  PresignedGetResult,
  PresignedUploadResult,
} from '../object-store-contract';
import {
  assertConfiguredBucket,
  assertKnowledgeObjectKey,
  expectedExpiry,
  mapObjectStoreError,
  normalizeEtag,
  objectStoreError,
  parseSingleRange,
  providerContractError,
} from '../object-store-contract';
import { materializeBody, normalizedMetadata } from './shared';

interface UploadedPartResponse {
  part: number;
  etag: string;
  size: number;
}

interface MinioClientWithParts {
  listParts(bucket: string, key: string, uploadId: string): Promise<UploadedPartResponse[]>;
}

export class MinioKnowledgeObjectStore implements ObjectStorePort {
  readonly provider = 'minio' as const;
  readonly bucket: string;
  readonly verificationStatus = 'REAL_VERIFIED' as const;
  private readonly client: Client;
  private bucketReady = false;

  constructor(private readonly config: MinioKnowledgeObjectStoreConfig) {
    this.bucket = config.bucket;
    this.client = new Client({
      endPoint: config.endPoint,
      port: config.port,
      useSSL: config.useSSL,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      region: config.region,
    });
  }

  async ensureBucket(context: KnowledgeObjectContext): Promise<void>;
  async ensureBucket(bucket: string, context: KnowledgeObjectContext): Promise<void>;
  async ensureBucket(
    bucketOrContext: string | KnowledgeObjectContext,
    maybeContext?: KnowledgeObjectContext,
  ): Promise<void> {
    const context = typeof bucketOrContext === 'string' ? maybeContext : bucketOrContext;
    if (!context) {
      throw objectStoreError('KNOWLEDGE_VALIDATION_FAILED', {
        requestId: 'storage',
        traceId: 'storage',
      });
    }
    const bucket = typeof bucketOrContext === 'string' ? bucketOrContext : this.bucket;
    assertConfiguredBucket(this.bucket, bucket, context);
    try {
      if (this.bucketReady) return;
      if (!(await this.client.bucketExists(bucket))) {
        await this.client.makeBucket(bucket, this.config.region);
      }
      this.bucketReady = true;
    } catch (error) {
      mapObjectStoreError(error, this.provider, 'ensureBucket', context);
    }
  }

  async putObject(
    input: ObjectPutInput,
    context: KnowledgeObjectContext,
  ): Promise<KnowledgeObjectRef> {
    assertKnowledgeObjectKey(input.key, context);
    const materialized = await materializeBody(input.body, input.sizeBytes, context);
    try {
      await this.ensureBucket(this.bucket, context);
      const result = await this.client.putObject(
        this.bucket,
        input.key,
        materialized.body,
        materialized.sizeBytes,
        {
          'Content-Type': input.contentType,
          ...input.metadata,
        },
      );
      const head = await this.headObject(this.bucket, input.key, context);
      return {
        provider: this.provider,
        bucket: this.bucket,
        key: input.key,
        workspaceId: input.workspaceId,
        knowledgeSpaceId: input.knowledgeSpaceId,
        size: head.size,
        etag: normalizeEtag(result.etag) || head.etag,
        sha256: materialized.sha256,
        ttlExpireAt: input.ttlExpireAt?.toISOString() ?? null,
      };
    } catch (error) {
      mapObjectStoreError(error, this.provider, 'putObject', context, input.key);
    }
  }

  async headObject(
    bucket: string,
    key: string,
    context: KnowledgeObjectContext,
  ): Promise<ObjectHeadResult> {
    assertConfiguredBucket(this.bucket, bucket, context);
    assertKnowledgeObjectKey(key, context);
    try {
      const result = await this.client.statObject(bucket, key);
      const etag = normalizeEtag(result.etag);
      if (!Number.isFinite(result.size) || result.size < 0 || etag.length === 0) {
        throw providerContractError(this.provider, 'headObject', context);
      }
      const metadata = normalizedMetadata(result.metaData);
      return {
        size: result.size,
        etag,
        contentType: metadata['content-type'] ?? null,
        metadata,
      };
    } catch (error) {
      mapObjectStoreError(error, this.provider, 'headObject', context, key);
    }
  }

  async getObject(
    bucket: string,
    key: string,
    range: string | null,
    context: KnowledgeObjectContext,
  ): Promise<ObjectStreamResult> {
    assertConfiguredBucket(this.bucket, bucket, context);
    assertKnowledgeObjectKey(key, context);
    const head = await this.headObject(bucket, key, context);
    const parsedRange = parseSingleRange(range, head.size, context);
    try {
      const partial = parsedRange
        ? await this.client.getPartialObject(
            bucket,
            key,
            parsedRange.start,
            parsedRange.end - parsedRange.start + 1,
          )
        : null;
      const body = partial
        ? partial instanceof Readable
          ? partial
          : Readable.from([Buffer.from(partial)])
        : await this.client.getObject(bucket, key);
      return {
        body,
        size: parsedRange ? parsedRange.end - parsedRange.start + 1 : head.size,
        etag: head.etag,
        contentType: head.contentType,
        contentRange: parsedRange
          ? `bytes ${parsedRange.start}-${parsedRange.end}/${head.size}`
          : null,
      };
    } catch (error) {
      mapObjectStoreError(error, this.provider, 'getObject', context, key);
    }
  }

  async presignPut(
    key: string,
    contentType: string,
    expiresSeconds: number,
    context: KnowledgeObjectContext,
    multipart?: { providerUploadId: string; partNumber: number },
  ): Promise<PresignedUploadResult> {
    assertKnowledgeObjectKey(key, context);
    try {
      const url = multipart
        ? await this.client.presignedUrl('PUT', this.bucket, key, expiresSeconds, {
            uploadId: multipart.providerUploadId,
            partNumber: String(multipart.partNumber),
          })
        : await this.client.presignedPutObject(this.bucket, key, expiresSeconds);
      return {
        url,
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        expiresAt: expectedExpiry(expiresSeconds),
      };
    } catch (error) {
      mapObjectStoreError(error, this.provider, 'presignPut', context, key);
    }
  }

  async presignGet(
    key: string,
    disposition: string | null,
    expiresSeconds: number,
    context: KnowledgeObjectContext,
  ): Promise<PresignedGetResult> {
    assertKnowledgeObjectKey(key, context);
    try {
      const url = await this.client.presignedGetObject(
        this.bucket,
        key,
        expiresSeconds,
        disposition ? { 'response-content-disposition': disposition } : undefined,
      );
      return { url, expiresAt: expectedExpiry(expiresSeconds) };
    } catch (error) {
      mapObjectStoreError(error, this.provider, 'presignGet', context, key);
    }
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
    metadata: Record<string, string>,
    context: KnowledgeObjectContext,
  ): Promise<string> {
    assertKnowledgeObjectKey(key, context);
    try {
      await this.ensureBucket(this.bucket, context);
      return await this.client.initiateNewMultipartUpload(this.bucket, key, {
        'Content-Type': contentType,
        ...metadata,
      });
    } catch (error) {
      mapObjectStoreError(error, this.provider, 'createMultipartUpload', context, key);
    }
  }

  async uploadPart(
    key: string,
    providerUploadId: string,
    partNumber: number,
    body: Uint8Array | Readable,
    context: KnowledgeObjectContext,
  ): Promise<MultipartPart> {
    assertKnowledgeObjectKey(key, context);
    const materialized = await materializeBody(body, undefined, context);
    try {
      const result = await this.client.uploadPart(
        {
          bucketName: this.bucket,
          objectName: key,
          uploadID: providerUploadId,
          partNumber,
          headers: {},
        },
        materialized.body,
      );
      return {
        partNumber,
        etag: normalizeEtag(result.etag),
        sizeBytes: materialized.sizeBytes,
      };
    } catch (error) {
      mapObjectStoreError(error, this.provider, 'uploadPart', context, key);
    }
  }

  async listParts(
    key: string,
    providerUploadId: string,
    context: KnowledgeObjectContext,
  ): Promise<MultipartPart[]> {
    assertKnowledgeObjectKey(key, context);
    try {
      const parts = await (this.client as unknown as MinioClientWithParts).listParts(
        this.bucket,
        key,
        providerUploadId,
      );
      return parts.map((part) => ({
        partNumber: part.part,
        etag: normalizeEtag(part.etag),
        sizeBytes: part.size,
      }));
    } catch (error) {
      mapObjectStoreError(error, this.provider, 'listParts', context, key);
    }
  }

  async completeMultipartUpload(
    key: string,
    providerUploadId: string,
    parts: readonly MultipartPart[],
    context: KnowledgeObjectContext,
  ): Promise<MultipartCompleteResult> {
    assertKnowledgeObjectKey(key, context);
    try {
      const result = await this.client.completeMultipartUpload(
        this.bucket,
        key,
        providerUploadId,
        parts.map((part) => ({ part: part.partNumber, etag: part.etag })),
      );
      const head = await this.headObject(this.bucket, key, context);
      return {
        etag: normalizeEtag(result.etag) || head.etag,
        sizeBytes: head.size,
      };
    } catch (error) {
      mapObjectStoreError(error, this.provider, 'completeMultipartUpload', context, key);
    }
  }

  async abortMultipartUpload(
    key: string,
    providerUploadId: string,
    context: KnowledgeObjectContext,
  ): Promise<{ aborted: boolean }> {
    assertKnowledgeObjectKey(key, context);
    try {
      await this.client.abortMultipartUpload(this.bucket, key, providerUploadId);
      return { aborted: true };
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        (error as { statusCode?: unknown }).statusCode === 404
      ) {
        return { aborted: true };
      }
      mapObjectStoreError(error, this.provider, 'abortMultipartUpload', context, key);
    }
  }

  async deleteObject(key: string, context: KnowledgeObjectContext): Promise<{ deleted: boolean }> {
    assertKnowledgeObjectKey(key, context);
    try {
      await this.client.removeObject(this.bucket, key);
      return { deleted: true };
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        (error as { statusCode?: unknown }).statusCode === 404
      ) {
        return { deleted: true };
      }
      mapObjectStoreError(error, this.provider, 'deleteObject', context, key);
    }
  }

  async put(
    input: {
      key: string;
      workspaceId: string;
      knowledgeSpaceId: string;
      body: Uint8Array;
      contentType: string;
      ttlExpireAt?: Date | null;
    },
    context: KnowledgeObjectContext,
  ): Promise<KnowledgeObjectRef> {
    return this.putObject(input, context);
  }

  async get(
    ref: KnowledgeObjectRef,
    context: KnowledgeObjectContext,
  ): Promise<{ ref: KnowledgeObjectRef; body: Uint8Array }> {
    const result = await this.getObject(ref.bucket, ref.key, null, context);
    const chunks: Buffer[] = [];
    for await (const chunk of result.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return {
      ref: { ...ref, size: result.size, etag: result.etag },
      body: Buffer.concat(chunks),
    };
  }

  async delete(
    ref: KnowledgeObjectRef,
    context: KnowledgeObjectContext,
  ): Promise<{ deleted: boolean }> {
    return this.deleteObject(ref.key, context);
  }

  async presign(
    ref: KnowledgeObjectRef,
    context: KnowledgeObjectContext,
    expiresSeconds: 60 | 300 | 3600,
  ): Promise<string> {
    return (await this.presignGet(ref.key, null, expiresSeconds, context)).url;
  }
}
