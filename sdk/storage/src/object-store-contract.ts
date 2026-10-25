import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { KnowledgeApiError, createKnowledgeError, type KnowledgeErrorCode } from '@kb/contracts';

export type KnowledgeObjectProvider = 'minio' | 'aws-s3' | 'r2' | 'cos' | 'oss';
export type KnowledgeObjectPurpose = 'source' | 'image' | 'export' | 'preview' | 'avatar';
export type ProviderVerificationStatus = 'REAL_VERIFIED' | 'EXTERNAL_UNVERIFIED';

export interface KnowledgeObjectRef {
  provider: KnowledgeObjectProvider;
  bucket: string;
  key: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  size: number;
  etag: string;
  sha256: string;
  ttlExpireAt: string | null;
}

export interface KnowledgeObjectContext {
  workspaceId: string;
  knowledgeSpaceId: string;
  requestId: string;
  traceId: string;
}

export interface KnowledgeObjectKeyInput {
  workspaceId: string;
  knowledgeSpaceId: string;
  sourceId: string;
  purpose: KnowledgeObjectPurpose;
  blobId: string;
  safeName: string;
}

export interface ObjectPutInput {
  key: string;
  body: Uint8Array | Readable;
  sizeBytes?: number;
  contentType: string;
  metadata?: Record<string, string>;
  workspaceId: string;
  knowledgeSpaceId: string;
  ttlExpireAt?: Date | null;
}

export interface ObjectCopyInput {
  sourceKey: string;
  targetKey: string;
  expectedSourceEtag: string;
  expectedSize: number;
  contentType: string;
  metadata?: Record<string, string>;
}

export interface ObjectCopyResult {
  sourceEtag: string;
  etag: string;
  sizeBytes: number;
}

export interface ObjectHeadResult {
  size: number;
  etag: string;
  contentType: string | null;
  metadata: Record<string, string>;
}

export interface ObjectStreamResult {
  body: Readable;
  size: number;
  etag: string;
  contentType: string | null;
  contentRange: string | null;
}

export interface PresignedUploadResult {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
}

export interface PresignedGetResult {
  url: string;
  expiresAt: string;
}

export interface MultipartPart {
  partNumber: number;
  etag: string;
  sizeBytes: number;
}

export interface MultipartCompleteResult {
  etag: string;
  sizeBytes: number;
}

export interface ObjectStoreCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface MinioKnowledgeObjectStoreConfig {
  provider: 'minio';
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  region: string;
  bucket: string;
  credentialRefs?: readonly string[];
}

export interface CloudKnowledgeObjectStoreConfig {
  provider: Exclude<KnowledgeObjectProvider, 'minio'>;
  endpoint: string;
  region: string;
  bucket: string;
  credentials: ObjectStoreCredentials;
  credentialRefs: readonly string[];
}

export type ObjectStoreConfig = MinioKnowledgeObjectStoreConfig | CloudKnowledgeObjectStoreConfig;
export type KnowledgeObjectStoreConfig = ObjectStoreConfig;

export interface ObjectStorePort {
  readonly provider: KnowledgeObjectProvider;
  readonly bucket: string;
  readonly verificationStatus: ProviderVerificationStatus;
  ensureBucket(bucket: string, context: KnowledgeObjectContext): Promise<void>;
  putObject(input: ObjectPutInput, context: KnowledgeObjectContext): Promise<KnowledgeObjectRef>;
  copyObjectImmutable(
    input: ObjectCopyInput,
    context: KnowledgeObjectContext,
  ): Promise<ObjectCopyResult>;
  headObject(
    bucket: string,
    key: string,
    context: KnowledgeObjectContext,
  ): Promise<ObjectHeadResult>;
  getObject(
    bucket: string,
    key: string,
    range: string | null,
    context: KnowledgeObjectContext,
  ): Promise<ObjectStreamResult>;
  presignPut(
    key: string,
    contentType: string,
    expiresSeconds: number,
    context: KnowledgeObjectContext,
    multipart?: { providerUploadId: string; partNumber: number },
  ): Promise<PresignedUploadResult>;
  presignGet(
    key: string,
    disposition: string | null,
    expiresSeconds: number,
    context: KnowledgeObjectContext,
  ): Promise<PresignedGetResult>;
  createMultipartUpload(
    key: string,
    contentType: string,
    metadata: Record<string, string>,
    context: KnowledgeObjectContext,
  ): Promise<string>;
  uploadPart(
    key: string,
    providerUploadId: string,
    partNumber: number,
    body: Uint8Array | Readable,
    context: KnowledgeObjectContext,
  ): Promise<MultipartPart>;
  listParts(
    key: string,
    providerUploadId: string,
    context: KnowledgeObjectContext,
  ): Promise<MultipartPart[]>;
  completeMultipartUpload(
    key: string,
    providerUploadId: string,
    parts: readonly MultipartPart[],
    context: KnowledgeObjectContext,
  ): Promise<MultipartCompleteResult>;
  abortMultipartUpload(
    key: string,
    providerUploadId: string,
    context: KnowledgeObjectContext,
  ): Promise<{ aborted: boolean }>;
  deleteObject(key: string, context: KnowledgeObjectContext): Promise<{ deleted: boolean }>;
}

export const KNOWLEDGE_OBJECT_PROVIDERS = [
  'minio',
  'aws-s3',
  'r2',
  'cos',
  'oss',
] as const satisfies readonly KnowledgeObjectProvider[];

const EXACT_HTTP_RANGE = /^bytes=(\d+)-(\d+)$/;

export function safeKeySegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe.length > 0 ? safe.slice(0, 180) : 'object';
}

export function knowledgeObjectKey(input: KnowledgeObjectKeyInput): string {
  return [
    'ws',
    safeKeySegment(input.workspaceId),
    'space',
    safeKeySegment(input.knowledgeSpaceId),
    'source',
    safeKeySegment(input.sourceId),
    input.purpose,
    safeKeySegment(input.blobId),
    safeKeySegment(input.safeName),
  ].join('/');
}

export function objectKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function objectStoreError(
  code: KnowledgeErrorCode,
  context: Pick<KnowledgeObjectContext, 'requestId' | 'traceId'>,
  details: Record<string, unknown> = {},
): KnowledgeApiError {
  return createKnowledgeError({
    code,
    requestId: context.requestId,
    traceId: context.traceId,
    details,
  });
}

function providerStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as {
    status?: unknown;
    statusCode?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  for (const value of [record.status, record.statusCode, record.$metadata?.httpStatusCode]) {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return null;
}

function providerCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as { code?: unknown; Code?: unknown; name?: unknown };
  for (const value of [record.code, record.Code, record.name]) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

export function isNotFoundProviderError(error: unknown): boolean {
  const status = providerStatus(error);
  const code = providerCode(error);
  return (
    status === 404 ||
    code === 'NoSuchKey' ||
    code === 'NotFound' ||
    code === 'NoSuchUpload' ||
    code === 'NoSuchBucket'
  );
}

export function isTimeoutProviderError(error: unknown): boolean {
  const code = providerCode(error);
  return (
    statusCode(error) === 408 ||
    code === 'TimeoutError' ||
    code === 'RequestTimeout' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    code === 'AbortError'
  );
}

export function isPreconditionProviderError(error: unknown): boolean {
  const status = providerStatus(error);
  const code = providerCode(error);
  return (
    status === 412 ||
    code === 'PreconditionFailed' ||
    code === 'PreconditionFailedError' ||
    code === 'ConditionalRequestConflict'
  );
}

function statusCode(error: unknown): number | null {
  return providerStatus(error);
}

export function mapObjectStoreError(
  error: unknown,
  provider: KnowledgeObjectProvider,
  operation: string,
  context: KnowledgeObjectContext,
  key?: string,
): never {
  if (error instanceof KnowledgeApiError) throw error;
  const status = providerStatus(error);
  const details: Record<string, unknown> = {
    provider,
    operation,
    ...(status === null ? {} : { status }),
    ...(key ? { objectKeyHash: objectKeyHash(key) } : {}),
  };
  if (isNotFoundProviderError(error)) {
    throw objectStoreError('KNOWLEDGE_NOT_FOUND', context, details);
  }
  if (isTimeoutProviderError(error)) {
    throw objectStoreError('KNOWLEDGE_DEPENDENCY_TIMEOUT', context, details);
  }
  throw objectStoreError('KNOWLEDGE_DEPENDENCY_UNAVAILABLE', context, details);
}

export function mapObjectCopyError(
  error: unknown,
  provider: KnowledgeObjectProvider,
  context: KnowledgeObjectContext,
  keys: readonly string[],
): never {
  if (error instanceof KnowledgeApiError) throw error;
  if (isPreconditionProviderError(error)) {
    throw objectStoreError('KNOWLEDGE_CONFLICT', context, {
      provider,
      operation: 'copyObjectImmutable',
      reason: 'source_etag_changed',
      objectKeyHashes: keys.map(objectKeyHash),
    });
  }
  const key = keys[0];
  mapObjectStoreError(error, provider, 'copyObjectImmutable', context, key);
}

export function providerContractError(
  provider: KnowledgeObjectProvider,
  operation: string,
  context: KnowledgeObjectContext,
): KnowledgeApiError {
  return objectStoreError('KNOWLEDGE_PROVIDER_CONTRACT_INVALID', context, {
    provider,
    operation,
  });
}

export function assertKnowledgeObjectKey(key: string, context: KnowledgeObjectContext): void {
  const expectedPrefix = `ws/${safeKeySegment(context.workspaceId)}/space/${safeKeySegment(
    context.knowledgeSpaceId,
  )}/`;
  if (
    !key.startsWith(expectedPrefix) ||
    key.startsWith('/') ||
    key.includes('..') ||
    key.includes('\\') ||
    key.includes('//')
  ) {
    throw objectStoreError('KNOWLEDGE_NOT_FOUND', context, {
      objectKeyHash: objectKeyHash(key),
    });
  }
}

export function assertKnowledgeObjectScope(
  ref: Pick<KnowledgeObjectRef, 'key' | 'workspaceId' | 'knowledgeSpaceId'>,
  context: KnowledgeObjectContext,
): void {
  if (
    ref.workspaceId !== context.workspaceId ||
    ref.knowledgeSpaceId !== context.knowledgeSpaceId
  ) {
    throw objectStoreError('KNOWLEDGE_NOT_FOUND', context, {
      objectKeyHash: objectKeyHash(ref.key),
    });
  }
  assertKnowledgeObjectKey(ref.key, context);
}

export function assertConfiguredBucket(
  configuredBucket: string,
  requestedBucket: string,
  context: KnowledgeObjectContext,
): void {
  if (configuredBucket !== requestedBucket) {
    throw objectStoreError('KNOWLEDGE_NOT_FOUND', context, {});
  }
}

export function parseSingleRange(
  range: string | null,
  size: number,
  context: KnowledgeObjectContext,
): { start: number; end: number; header: string } | null {
  if (range === null) return null;
  const match = EXACT_HTTP_RANGE.exec(range);
  if (!match) {
    throw objectStoreError('KNOWLEDGE_RANGE_NOT_SATISFIABLE', context, {
      range,
      size,
    });
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start > end ||
    start >= size ||
    end >= size
  ) {
    throw objectStoreError('KNOWLEDGE_RANGE_NOT_SATISFIABLE', context, {
      range,
      size,
    });
  }
  return {
    start,
    end,
    header: `bytes=${start}-${end}`,
  };
}

export function normalizeEtag(value: unknown): string {
  return typeof value === 'string' ? value.replaceAll('"', '') : '';
}

export function expectedExpiry(expiresSeconds: number): string {
  return new Date(Date.now() + expiresSeconds * 1000).toISOString();
}
