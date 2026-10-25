import type { Readable } from 'node:stream';
import COS from 'cos-nodejs-sdk-v5';
import type {
  CloudKnowledgeObjectStoreConfig,
  KnowledgeObjectContext,
  KnowledgeObjectRef,
  MultipartCompleteResult,
  MultipartPart,
  ObjectCopyInput,
  ObjectCopyResult,
  ObjectHeadResult,
  ObjectPutInput,
  ObjectStorePort,
  ObjectStreamResult,
  PresignedGetResult,
  PresignedUploadResult,
} from '../object-store-contract';
import {
  assertKnowledgeObjectKey,
  expectedExpiry,
  isNotFoundProviderError,
  mapObjectCopyError,
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

interface CosResult {
  ETag?: string;
  ContentLength?: number;
  UploadId?: string;
  Url?: string;
  Body?: unknown;
  headers?: Record<string, unknown>;
  Part?: Array<{ PartNumber: number; ETag: string; Size: number }>;
  IsTruncated?: string;
  NextPartNumberMarker?: number;
}

interface CosClientLike {
  headBucket(params: Record<string, unknown>): Promise<unknown>;
  putBucket(params: Record<string, unknown>): Promise<unknown>;
  putObject(params: Record<string, unknown>): Promise<CosResult>;
  putObjectCopy(params: Record<string, unknown>): Promise<CosResult>;
  headObject(params: Record<string, unknown>): Promise<CosResult>;
  getObject(params: Record<string, unknown>): Promise<CosResult>;
  deleteObject(params: Record<string, unknown>): Promise<unknown>;
  getObjectUrl(params: Record<string, unknown>): Promise<CosResult>;
  multipartInit(params: Record<string, unknown>): Promise<CosResult>;
  multipartUpload(params: Record<string, unknown>): Promise<CosResult>;
  multipartListPart(params: Record<string, unknown>): Promise<CosResult>;
  multipartComplete(params: Record<string, unknown>): Promise<CosResult>;
  multipartAbort(params: Record<string, unknown>): Promise<unknown>;
}

function endpointDomain(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).host;
  } catch {
    return undefined;
  }
}

function endpointProtocol(endpoint: string): 'http:' | 'https:' {
  return endpoint.startsWith('http:') ? 'http:' : 'https:';
}

export class CosKnowledgeObjectStore implements ObjectStorePort {
  readonly provider = 'cos' as const;
  readonly bucket: string;
  readonly verificationStatus = 'EXTERNAL_UNVERIFIED' as const;
  private readonly client: CosClientLike;

  constructor(
    private readonly config: CloudKnowledgeObjectStoreConfig,
    injectedClient?: CosClientLike,
  ) {
    this.bucket = config.bucket;
    this.client =
      injectedClient ??
      (new COS({
        SecretId: config.credentials.accessKeyId,
        SecretKey: config.credentials.secretAccessKey,
        ...(config.credentials.sessionToken
          ? { SecurityToken: config.credentials.sessionToken }
          : {}),
        Domain: endpointDomain(config.endpoint),
        Protocol: endpointProtocol(config.endpoint),
        Timeout: 120_000,
      }) as unknown as CosClientLike);
  }

  private params(key?: string): Record<string, unknown> {
    return {
      Bucket: this.bucket,
      Region: this.config.region,
      ...(key ? { Key: key } : {}),
    };
  }

  async ensureBucket(bucket: string, context: KnowledgeObjectContext): Promise<void> {
    if (bucket !== this.bucket) {
      throw providerContractError(this.provider, 'ensureBucket', context);
    }
    try {
      await this.client.headBucket(this.params());
    } catch (error) {
      if (!isNotFoundProviderError(error)) {
        mapObjectStoreError(error, this.provider, 'ensureBucket', context);
      }
      try {
        await this.client.putBucket(this.params());
      } catch (createError) {
        mapObjectStoreError(createError, this.provider, 'createBucket', context);
      }
    }
  }

  async putObject(
    input: ObjectPutInput,
    context: KnowledgeObjectContext,
  ): Promise<KnowledgeObjectRef> {
    assertKnowledgeObjectKey(input.key, context);
    const materialized = await materializeBody(input.body, input.sizeBytes, context);
    try {
      await this.client.putObject({
        ...this.params(input.key),
        Body: materialized.body,
        ContentLength: materialized.sizeBytes,
        ContentType: input.contentType,
        ...Object.fromEntries(
          Object.entries(input.metadata ?? {}).map(([key, value]) => [`x-cos-meta-${key}`, value]),
        ),
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

  async copyObjectImmutable(
    input: ObjectCopyInput,
    context: KnowledgeObjectContext,
  ): Promise<ObjectCopyResult> {
    assertKnowledgeObjectKey(input.sourceKey, context);
    assertKnowledgeObjectKey(input.targetKey, context);
    if (input.sourceKey === input.targetKey || input.expectedSourceEtag.length === 0) {
      throw providerContractError(this.provider, 'copyObjectImmutable', context);
    }
    const encodedSource = input.sourceKey
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    try {
      const copied = await this.client.putObjectCopy({
        ...this.params(input.targetKey),
        CopySource: `${this.bucket}.cos.${this.config.region}.myqcloud.com/${encodedSource}`,
        CopySourceIfMatch: input.expectedSourceEtag,
        MetadataDirective: 'Replaced',
        ContentType: input.contentType,
        Headers: Object.fromEntries(
          Object.entries(input.metadata ?? {}).map(([key, value]) => [`x-cos-meta-${key}`, value]),
        ),
      });
      const head = await this.headObject(this.bucket, input.targetKey, context);
      const etag = normalizeEtag(copied.ETag) || head.etag;
      if (head.size !== input.expectedSize || etag.length === 0) {
        throw providerContractError(this.provider, 'copyObjectImmutable', context);
      }
      return {
        sourceEtag: input.expectedSourceEtag,
        etag,
        sizeBytes: head.size,
      };
    } catch (error) {
      mapObjectCopyError(error, this.provider, context, [input.sourceKey, input.targetKey]);
    }
  }

  async headObject(
    bucket: string,
    key: string,
    context: KnowledgeObjectContext,
  ): Promise<ObjectHeadResult> {
    assertKnowledgeObjectKey(key, context);
    if (bucket !== this.bucket) {
      throw providerContractError(this.provider, 'headObject', context);
    }
    try {
      const result = await this.client.headObject(this.params(key));
      const size =
        numericHeader(result.headers, 'content-length') ?? numericHeader(result, 'ContentLength');
      const etag = normalizeEtag(result.ETag ?? headerValue(result.headers, 'etag'));
      if (size === null || size < 0 || etag.length === 0) {
        throw providerContractError(this.provider, 'headObject', context);
      }
      return {
        size,
        etag,
        contentType: headerValue(result.headers, 'content-type'),
        metadata: normalizedMetadata(result.headers),
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
    assertKnowledgeObjectKey(key, context);
    const head = await this.headObject(bucket, key, context);
    const parsedRange = parseSingleRange(range, head.size, context);
    try {
      const result = await this.client.getObject({
        ...this.params(key),
        ...(parsedRange ? { Range: parsedRange.header } : {}),
      });
      return {
        body: readableFrom(result.Body),
        size: parsedRange ? parsedRange.end - parsedRange.start + 1 : head.size,
        etag: normalizeEtag(result.ETag) || head.etag,
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
      const result = await this.client.getObjectUrl({
        ...this.params(key),
        Method: 'PUT',
        Sign: true,
        Expires: expiresSeconds,
        ...(multipart
          ? {
              Query: {
                uploadId: multipart.providerUploadId,
                partNumber: String(multipart.partNumber),
              },
            }
          : {}),
      });
      if (typeof result.Url !== 'string') {
        throw providerContractError(this.provider, 'presignPut', context);
      }
      return {
        url: result.Url,
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
      const result = await this.client.getObjectUrl({
        ...this.params(key),
        Method: 'GET',
        Sign: true,
        Expires: expiresSeconds,
        ...(disposition ? { Query: { 'response-content-disposition': disposition } } : {}),
      });
      if (typeof result.Url !== 'string') {
        throw providerContractError(this.provider, 'presignGet', context);
      }
      return { url: result.Url, expiresAt: expectedExpiry(expiresSeconds) };
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
      const result = await this.client.multipartInit({
        ...this.params(key),
        ContentType: contentType,
        ...Object.fromEntries(
          Object.entries(metadata).map(([entryKey, value]) => [`x-cos-meta-${entryKey}`, value]),
        ),
      });
      if (typeof result.UploadId !== 'string' || result.UploadId.length === 0) {
        throw providerContractError(this.provider, 'createMultipartUpload', context);
      }
      return result.UploadId;
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
      const result = await this.client.multipartUpload({
        ...this.params(key),
        UploadId: providerUploadId,
        PartNumber: partNumber,
        Body: materialized.body,
        ContentLength: materialized.sizeBytes,
      });
      if (typeof result.ETag !== 'string' || result.ETag.length === 0) {
        throw providerContractError(this.provider, 'uploadPart', context);
      }
      return {
        partNumber,
        etag: normalizeEtag(result.ETag),
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
    const parts: MultipartPart[] = [];
    let marker: number | undefined;
    try {
      do {
        const result = await this.client.multipartListPart({
          ...this.params(key),
          UploadId: providerUploadId,
          ...(marker === undefined ? {} : { PartNumberMarker: String(marker) }),
        });
        for (const part of result.Part ?? []) {
          parts.push({
            partNumber: part.PartNumber,
            etag: normalizeEtag(part.ETag),
            sizeBytes: part.Size,
          });
        }
        marker =
          result.IsTruncated === 'true' || result.IsTruncated === '1'
            ? result.NextPartNumberMarker
            : undefined;
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
    assertKnowledgeObjectKey(key, context);
    try {
      const result = await this.client.multipartComplete({
        ...this.params(key),
        UploadId: providerUploadId,
        Parts: parts.map((part) => ({
          PartNumber: part.partNumber,
          ETag: part.etag,
        })),
      });
      const head = await this.headObject(this.bucket, key, context);
      return {
        etag: normalizeEtag(result.ETag) || head.etag,
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
      await this.client.multipartAbort({
        ...this.params(key),
        UploadId: providerUploadId,
      });
      return { aborted: true };
    } catch (error) {
      if (isNotFoundProviderError(error)) return { aborted: true };
      mapObjectStoreError(error, this.provider, 'abortMultipartUpload', context, key);
    }
  }

  async deleteObject(key: string, context: KnowledgeObjectContext): Promise<{ deleted: boolean }> {
    assertKnowledgeObjectKey(key, context);
    try {
      await this.client.deleteObject(this.params(key));
      return { deleted: true };
    } catch (error) {
      if (isNotFoundProviderError(error)) return { deleted: true };
      mapObjectStoreError(error, this.provider, 'deleteObject', context, key);
    }
  }
}
