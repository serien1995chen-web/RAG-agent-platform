import { createHash } from 'node:crypto';
import { Client } from 'minio';
import { createKnowledgeError } from '@kb/contracts';

export type KnowledgeObjectProvider = 'minio' | 'aws-s3' | 'r2' | 'cos' | 'oss';
export type KnowledgeObjectPurpose = 'source' | 'image' | 'export' | 'preview' | 'avatar';

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

export const KNOWLEDGE_OBJECT_PROVIDERS = [
  'minio',
  'aws-s3',
  'r2',
  'cos',
  'oss',
] as const satisfies readonly KnowledgeObjectProvider[];

export interface MinioKnowledgeObjectStoreConfig {
  provider: 'minio';
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  region: string;
  bucket: string;
}

export interface ExternalKnowledgeObjectStoreContract {
  provider: Exclude<KnowledgeObjectProvider, 'minio'>;
  region: string | null;
  endpoint: string;
  bucket: string;
  credentialRefs: readonly string[];
  status: 'EXTERNAL_UNVERIFIED';
}

export type KnowledgeObjectStoreConfig =
  | MinioKnowledgeObjectStoreConfig
  | ExternalKnowledgeObjectStoreContract;

function safeKeySegment(value: string): string {
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

function objectKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function objectError(
  code: 'KNOWLEDGE_AUTH_REQUIRED' | 'KNOWLEDGE_NOT_FOUND' | 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
  context: Pick<KnowledgeObjectContext, 'requestId' | 'traceId'>,
  details: Record<string, unknown>,
) {
  return createKnowledgeError({
    code,
    requestId: context.requestId,
    traceId: context.traceId,
    details,
  });
}

export function assertKnowledgeObjectScope(
  ref: Pick<KnowledgeObjectRef, 'key' | 'workspaceId' | 'knowledgeSpaceId'>,
  context: KnowledgeObjectContext,
): void {
  const expectedPrefix = `ws/${safeKeySegment(context.workspaceId)}/space/${safeKeySegment(
    context.knowledgeSpaceId,
  )}/`;
  const invalid =
    ref.workspaceId !== context.workspaceId ||
    ref.knowledgeSpaceId !== context.knowledgeSpaceId ||
    !ref.key.startsWith(expectedPrefix) ||
    ref.key.startsWith('/') ||
    ref.key.includes('..') ||
    ref.key.includes('\\');
  if (invalid) {
    throw objectError('KNOWLEDGE_NOT_FOUND', context, {
      objectKeyHash: objectKeyHash(ref.key),
    });
  }
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

export class MinioKnowledgeObjectStore {
  private readonly client: Client;
  private bucketReady = false;

  constructor(private readonly config: MinioKnowledgeObjectStoreConfig) {
    this.client = new Client({
      endPoint: config.endPoint,
      port: config.port,
      useSSL: config.useSSL,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      region: config.region,
    });
  }

  async ensureBucket(context: KnowledgeObjectContext): Promise<void> {
    try {
      if (this.bucketReady) return;
      if (!(await this.client.bucketExists(this.config.bucket))) {
        await this.client.makeBucket(this.config.bucket, this.config.region);
      }
      this.bucketReady = true;
    } catch {
      throw objectError('KNOWLEDGE_DEPENDENCY_UNAVAILABLE', context, {
        dependency: 's3',
        operation: 'ensureBucket',
      });
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
    const ref: KnowledgeObjectRef = {
      provider: 'minio',
      bucket: this.config.bucket,
      key: input.key,
      workspaceId: input.workspaceId,
      knowledgeSpaceId: input.knowledgeSpaceId,
      size: input.body.byteLength,
      etag: '',
      sha256: createHash('sha256').update(input.body).digest('hex'),
      ttlExpireAt: input.ttlExpireAt?.toISOString() ?? null,
    };
    assertKnowledgeObjectScope(ref, context);
    try {
      await this.ensureBucket(context);
      const result = await this.client.putObject(
        this.config.bucket,
        ref.key,
        Buffer.from(input.body),
        input.body.byteLength,
        { 'Content-Type': input.contentType },
      );
      return { ...ref, etag: String(result.etag ?? '').replaceAll('"', '') };
    } catch (error) {
      if (error instanceof Error && error.name === 'KnowledgeApiError') throw error;
      throw objectError('KNOWLEDGE_DEPENDENCY_UNAVAILABLE', context, {
        dependency: 's3',
        operation: 'put',
        objectKeyHash: objectKeyHash(ref.key),
      });
    }
  }

  async get(
    ref: KnowledgeObjectRef,
    context: KnowledgeObjectContext,
  ): Promise<{ ref: KnowledgeObjectRef; body: Uint8Array }> {
    assertKnowledgeObjectScope(ref, context);
    try {
      const stream = await this.client.getObject(ref.bucket, ref.key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return { ref, body: Buffer.concat(chunks) };
    } catch (error) {
      if (isNotFound(error)) {
        throw objectError('KNOWLEDGE_NOT_FOUND', context, {
          objectKeyHash: objectKeyHash(ref.key),
        });
      }
      throw objectError('KNOWLEDGE_DEPENDENCY_UNAVAILABLE', context, {
        dependency: 's3',
        operation: 'get',
        objectKeyHash: objectKeyHash(ref.key),
      });
    }
  }

  async delete(
    ref: KnowledgeObjectRef,
    context: KnowledgeObjectContext,
  ): Promise<{ deleted: boolean }> {
    assertKnowledgeObjectScope(ref, context);
    try {
      await this.client.removeObject(ref.bucket, ref.key);
      return { deleted: true };
    } catch (error) {
      if (isNotFound(error)) return { deleted: true };
      throw objectError('KNOWLEDGE_DEPENDENCY_UNAVAILABLE', context, {
        dependency: 's3',
        operation: 'delete',
        objectKeyHash: objectKeyHash(ref.key),
      });
    }
  }

  async presign(
    ref: KnowledgeObjectRef,
    context: KnowledgeObjectContext,
    expiresSeconds: 60 | 300 | 3600,
  ): Promise<string> {
    assertKnowledgeObjectScope(ref, context);
    return this.client.presignedGetObject(ref.bucket, ref.key, expiresSeconds);
  }
}

export function createKnowledgeObjectStore(
  config: KnowledgeObjectStoreConfig,
): MinioKnowledgeObjectStore | ExternalKnowledgeObjectStoreContract {
  if (config.provider === 'minio') return new MinioKnowledgeObjectStore(config);
  return { ...config, status: 'EXTERNAL_UNVERIFIED' };
}
