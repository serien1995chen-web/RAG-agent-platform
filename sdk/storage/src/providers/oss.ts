import type { Readable } from 'node:stream';
import OSS from 'ali-oss';
import type {
  CloudKnowledgeObjectStoreConfig,
  KnowledgeObjectContext,
  KnowledgeObjectRef,
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
  expectedExpiry,
  isNotFoundProviderError,
  mapObjectStoreError,
  normalizeEtag,
  parseSingleRange,
  providerContractError,
} from '../object-store-contract';
import {
  headerValue,
  materializeBody,
  numericHeader,
  normalizedMetadata,
  readableFrom,
} from './shared';

interface OssResult {
  etag?: string;
  uploadId?: string;
  stream?: unknown;
  res?: { headers?: Record<string, unknown> };
  parts?: Array<{
    PartNumber?: number;
    partNumber?: number;
    ETag?: string;
    etag?: string;
    Size?: number;
    size?: number;
  }>;
  isTruncated?: boolean;
  nextPartNumberMarker?: number | string;
}

interface OssClientLike {
  getBucketInfo(bucket: string): Promise<unknown>;
  putBucket(bucket: string): Promise<unknown>;
  put(key: string, body: Buffer, options: Record<string, unknown>): Promise<OssResult>;
  head(key: string, options?: Record<string, unknown>): Promise<OssResult>;
  getStream(key: string, options?: Record<string, unknown>): Promise<OssResult>;
  delete(key: string, options?: Record<string, unknown>): Promise<unknown>;
  signatureUrl(key: string, options?: Record<string, unknown>): string;
  initMultipartUpload(key: string, options?: Record<string, unknown>): Promise<OssResult>;
  uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
    start: number,
    end: number,
    options?: Record<string, unknown>,
  ): Promise<OssResult>;
  listParts(
    key: string,
    uploadId: string,
    query?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<OssResult>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ number: number; etag: string }>,
    options?: Record<string, unknown>,
  ): Promise<OssResult>;
  abortMultipartUpload(
    key: string,
    uploadId: string,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

export class OssKnowledgeObjectStore implements ObjectStorePort {
  readonly provider = 'oss' as const;
  readonly bucket: string;
  readonly verificationStatus = 'EXTERNAL_UNVERIFIED' as const;
  private readonly client: OssClientLike;

  constructor(private readonly config: CloudKnowledgeObjectStoreConfig) {
    this.bucket = config.bucket;
    this.client = new OSS({
      region: config.region,
      endpoint: endpointHost(config.endpoint),
      bucket: config.bucket,
      accessKeyId: config.credentials.accessKeyId,
      accessKeySecret: config.credentials.secretAccessKey,
      ...(config.credentials.sessionToken ? { stsToken: config.credentials.sessionToken } : {}),
      secure: config.endpoint.startsWith('https:'),
      timeout: 120_000,
    }) as unknown as OssClientLike;
  }

  async ensureBucket(bucket: string, context: KnowledgeObjectContext): Promise<void> {
    if (bucket !== this.bucket) {
      throw providerContractError(this.provider, 'ensureBucket', context);
    }
    try {
      await this.client.getBucketInfo(bucket);
    } catch (error) {
      if (!isNotFoundProviderError(error)) {
        mapObjectStoreError(error, this.provider, 'ensureBucket', context);
      }
      try {
        await this.client.putBucket(bucket);
      } catch (createError) {
        mapObjectStoreError(createError, this.provider, 'createBucket', context);
      }
    }
  }

  async putObject(
    input: ObjectPutInput,
    context: KnowledgeObjectContext,
  ): Promise<KnowledgeObjectRef> {
    const materialized = await materializeBody(input.body, input.sizeBytes, context);
    try {
      await this.client.put(input.key, materialized.body, {
        mime: input.contentType,
        headers: input.metadata,
      });
      const head = await this.headObject(this.bucket, input.key, context);
      return {
        provider: this.provider,
        bucket: this.bucket,
        key: input.key,
        workspaceId: input.workspaceId,
        knowledgeSpaceId: input.knowledgeSpaceId,
        size: head.size,
        etag: head.etag,
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
    if (bucket !== this.bucket) {
      throw providerContractError(this.provider, 'headObject', context);
    }
    try {
      const result = await this.client.head(key);
      const headers = result.res?.headers;
      const size = numericHeader(headers, 'content-length');
      const etag = normalizeEtag(headerValue(headers, 'etag') ?? result.etag);
      if (size === null || size < 0 || etag.length === 0) {
        throw providerContractError(this.provider, 'headObject', context);
      }
      return {
        size,
        etag,
        contentType: headerValue(headers, 'content-type'),
        metadata: normalizedMetadata(headers),
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
    const head = await this.headObject(bucket, key, context);
    const parsedRange = parseSingleRange(range, head.size, context);
    try {
      const result = await this.client.getStream(
        key,
        parsedRange ? { headers: { Range: parsedRange.header } } : undefined,
      );
      return {
        body: readableFrom(result.stream),
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
    try {
      const url = this.client.signatureUrl(key, {
        method: 'PUT',
        expires: expiresSeconds,
        'Content-Type': contentType,
        ...(multipart
          ? {
              query: {
                uploadId: multipart.providerUploadId,
                partNumber: String(multipart.partNumber),
              },
            }
          : {}),
      });
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
    try {
      const url = this.client.signatureUrl(key, {
        method: 'GET',
        expires: expiresSeconds,
        ...(disposition
          ? {
              response: {
                'content-disposition': disposition,
              },
            }
          : {}),
      });
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
    try {
      const result = await this.client.initMultipartUpload(key, {
        mime: contentType,
        headers: metadata,
      });
      if (typeof result.uploadId !== 'string' || result.uploadId.length === 0) {
        throw providerContractError(this.provider, 'createMultipartUpload', context);
      }
      return result.uploadId;
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
    const materialized = await materializeBody(body, undefined, context);
    try {
      const result = await this.client.uploadPart(
        key,
        providerUploadId,
        partNumber,
        materialized.body,
        0,
        materialized.sizeBytes,
      );
      const etag = normalizeEtag(result.etag);
      if (etag.length === 0) {
        throw providerContractError(this.provider, 'uploadPart', context);
      }
      return {
        partNumber,
        etag,
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
    const parts: MultipartPart[] = [];
    let marker: number | undefined;
    try {
      do {
        const result = await this.client.listParts(key, providerUploadId, {
          ...(marker === undefined ? {} : { 'part-number-marker': marker }),
        });
        for (const part of result.parts ?? []) {
          const partNumber = part.PartNumber ?? part.partNumber;
          const etag = normalizeEtag(part.ETag ?? part.etag);
          const sizeBytes = part.Size ?? part.size;
          if (
            typeof partNumber !== 'number' ||
            etag.length === 0 ||
            typeof sizeBytes !== 'number'
          ) {
            throw providerContractError(this.provider, 'listParts', context);
          }
          parts.push({ partNumber, etag, sizeBytes });
        }
        const nextMarker = Number(result.nextPartNumberMarker);
        marker = result.isTruncated && Number.isFinite(nextMarker) ? nextMarker : undefined;
      } while (marker !== undefined);
      return parts.sort((a, b) => a.partNumber - b.partNumber);
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
    try {
      const result = await this.client.completeMultipartUpload(
        key,
        providerUploadId,
        parts.map((part) => ({ number: part.partNumber, etag: part.etag })),
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
    try {
      await this.client.abortMultipartUpload(key, providerUploadId);
      return { aborted: true };
    } catch (error) {
      if (isNotFoundProviderError(error)) return { aborted: true };
      mapObjectStoreError(error, this.provider, 'abortMultipartUpload', context, key);
    }
  }

  async deleteObject(key: string, context: KnowledgeObjectContext): Promise<{ deleted: boolean }> {
    try {
      await this.client.delete(key);
      return { deleted: true };
    } catch (error) {
      if (isNotFoundProviderError(error)) return { deleted: true };
      mapObjectStoreError(error, this.provider, 'deleteObject', context, key);
    }
  }
}
