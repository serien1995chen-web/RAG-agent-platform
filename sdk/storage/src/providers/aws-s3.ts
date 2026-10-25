import type { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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
import { materializeBody, normalizedMetadata, readableFrom } from './shared';

export class AwsS3KnowledgeObjectStore implements ObjectStorePort {
  readonly provider: 'aws-s3' | 'r2';
  readonly bucket: string;
  readonly verificationStatus = 'EXTERNAL_UNVERIFIED' as const;
  private readonly client: S3Client;

  constructor(private readonly config: CloudKnowledgeObjectStoreConfig) {
    if (config.provider === 'cos' || config.provider === 'oss') {
      throw providerContractError(config.provider, 'createAwsS3Store', {
        requestId: 'config',
        traceId: 'config',
        workspaceId: '',
        knowledgeSpaceId: '',
      });
    }
    this.provider = config.provider;
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.provider === 'r2',
      credentials: {
        accessKeyId: config.credentials.accessKeyId,
        secretAccessKey: config.credentials.secretAccessKey,
        ...(config.credentials.sessionToken
          ? { sessionToken: config.credentials.sessionToken }
          : {}),
      },
    });
  }

  async ensureBucket(bucket: string, context: KnowledgeObjectContext): Promise<void> {
    if (bucket !== this.bucket) {
      throw providerContractError(this.provider, 'ensureBucket', context);
    }
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (error) {
      if (!isNotFoundProviderError(error)) {
        mapObjectStoreError(error, this.provider, 'ensureBucket', context);
      }
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
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
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          Body: materialized.body,
          ContentLength: materialized.sizeBytes,
          ContentType: input.contentType,
          Metadata: input.metadata,
        }),
      );
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
      const result = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      const etag = normalizeEtag(result.ETag);
      const size = result.ContentLength;
      if (etag.length === 0 || typeof size !== 'number' || !Number.isFinite(size)) {
        throw providerContractError(this.provider, 'headObject', context);
      }
      return {
        size,
        etag,
        contentType: result.ContentType ?? null,
        metadata: normalizedMetadata(result.Metadata),
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
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(parsedRange ? { Range: parsedRange.header } : {}),
        }),
      );
      return {
        body: readableFrom(result.Body),
        size: parsedRange ? parsedRange.end - parsedRange.start + 1 : head.size,
        etag: normalizeEtag(result.ETag) || head.etag,
        contentType: result.ContentType ?? head.contentType,
        contentRange: result.ContentRange ?? null,
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
      const url = multipart
        ? await getSignedUrl(
            this.client,
            new UploadPartCommand({
              Bucket: this.bucket,
              Key: key,
              UploadId: multipart.providerUploadId,
              PartNumber: multipart.partNumber,
            }),
            { expiresIn: expiresSeconds },
          )
        : await getSignedUrl(
            this.client,
            new PutObjectCommand({
              Bucket: this.bucket,
              Key: key,
              ContentType: contentType,
            }),
            { expiresIn: expiresSeconds },
          );
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
      const url = await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ...(disposition ? { ResponseContentDisposition: disposition } : {}),
        }),
        { expiresIn: expiresSeconds },
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
    try {
      const result = await this.client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: contentType,
          Metadata: metadata,
        }),
      );
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
    const materialized = await materializeBody(body, undefined, context);
    try {
      const result = await this.client.send(
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: providerUploadId,
          PartNumber: partNumber,
          Body: materialized.body,
          ContentLength: materialized.sizeBytes,
        }),
      );
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
    const parts: MultipartPart[] = [];
    let marker: string | undefined;
    try {
      do {
        const result = await this.client.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: providerUploadId,
            ...(marker ? { PartNumberMarker: marker } : {}),
          }),
        );
        for (const part of result.Parts ?? []) {
          if (
            typeof part.PartNumber !== 'number' ||
            typeof part.Size !== 'number' ||
            typeof part.ETag !== 'string'
          ) {
            throw providerContractError(this.provider, 'listParts', context);
          }
          parts.push({
            partNumber: part.PartNumber,
            etag: normalizeEtag(part.ETag),
            sizeBytes: part.Size,
          });
        }
        marker = result.NextPartNumberMarker;
      } while (marker);
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
      const result = await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: providerUploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
      );
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
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: providerUploadId,
        }),
      );
      return { aborted: true };
    } catch (error) {
      if (isNotFoundProviderError(error)) return { aborted: true };
      mapObjectStoreError(error, this.provider, 'abortMultipartUpload', context, key);
    }
  }

  async deleteObject(key: string, context: KnowledgeObjectContext): Promise<{ deleted: boolean }> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      return { deleted: true };
    } catch (error) {
      if (isNotFoundProviderError(error)) return { deleted: true };
      mapObjectStoreError(error, this.provider, 'deleteObject', context, key);
    }
  }
}
