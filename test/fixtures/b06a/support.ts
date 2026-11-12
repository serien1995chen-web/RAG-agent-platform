import { randomUUID } from 'node:crypto';
import type { Connection } from 'mongoose';
import { createKnowledgeMongoConnection } from '../../../packages/service/src/shared/runtime/knowledge-connections';
import {
  KNOWLEDGE_SCHEMA_REGISTRY,
  ensureKnowledgeCollections,
  registerKnowledgeModels,
} from '../../../packages/service/src/shared/persistence/schemas/knowledge-index';
import { FileTicketService, MinioKnowledgeObjectStore } from '../../../sdk/storage/src/index';
import { FileApplication } from '../../../packages/service/src/modules/knowledge/application/file.application';
import { ObjectStoreArchiveSafetyAdapter } from '../../../projects/app/src/runtime/archive-safety.adapter';
import { KnowledgeObjectRefRepository } from '../../../packages/service/src/modules/knowledge/repository/object-ref.repository';
import type {
  AccessPort,
  CatalogPort,
  ObjectRefView,
  ObjectStoreApplicationPort,
} from '../../../packages/service/src/modules/knowledge/application/ports';
import { createKnowledgeError } from '../../../packages/contracts/src/errors/knowledge-errors';
import type { TenantContext } from '../../../packages/service/src/shared/persistence/knowledge/tenant';

const TICKET_SECRET = 'b06a-shared-ticket-secret-at-least-32-bytes-long';

export interface B06aEnv {
  suffix: string;
  workspaceId: string;
  otherWorkspaceId: string;
  memberId: string;
  spaceId: string;
  otherSpaceId: string;
  context: TenantContext;
  otherContext: TenantContext;
  connection: Connection;
  store: MinioKnowledgeObjectStore;
  repository: KnowledgeObjectRefRepository;
  files: FileApplication;
  objects: Set<string>;
  permission: { denyWrite: boolean; denyRead: boolean };
  storageContext(space?: string): {
    workspaceId: string;
    knowledgeSpaceId: string;
    requestId: string;
    traceId: string;
  };
  track(ref: ObjectRefView | null | undefined): void;
  cleanup(): Promise<void>;
}

export function makeContext(workspaceId: string, memberId: string, suffix: string): TenantContext {
  return {
    workspaceId,
    memberId,
    requestId: 'req_b06a_' + suffix,
    traceId: suffix.padEnd(32, '0').slice(0, 32),
    scopes: ['knowledge:read', 'knowledge:write', 'knowledge:manage'],
  };
}

export function s3Config() {
  const endpoint = new URL(process.env.KB_TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000');
  return {
    provider: 'minio' as const,
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
    useSSL: endpoint.protocol === 'https:',
    accessKey: process.env.KB_TEST_S3_ACCESS_KEY ?? 'minioadmin',
    secretKey: process.env.KB_TEST_S3_SECRET_KEY ?? 'minioadmin',
    region: process.env.KB_TEST_S3_REGION ?? 'us-east-1',
    bucket: process.env.KB_TEST_S3_BUCKET ?? 'kb-test',
  };
}

export async function createB06aEnv(prefix: string): Promise<B06aEnv> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const workspaceId = 'ws_b06a_' + prefix + '_' + suffix;
  const otherWorkspaceId = 'ws_b06a_other_' + prefix + '_' + suffix;
  const memberId = 'mem_b06a_' + suffix;
  const connection = await createKnowledgeMongoConnection(
    process.env.KB_TEST_MONGO_URI ??
      'mongodb://127.0.0.1:27017/kb_b06a_' + prefix + '_' + suffix + '?directConnection=true',
  );
  await ensureKnowledgeCollections(connection);
  registerKnowledgeModels(connection);
  const store = new MinioKnowledgeObjectStore(s3Config());
  const context = makeContext(workspaceId, memberId, suffix);
  const otherContext = makeContext(otherWorkspaceId, 'mem_other_' + suffix, suffix);
  const spaceId = randomUUID().replaceAll('-', '').slice(0, 24);
  const otherSpaceId = randomUUID().replaceAll('-', '').slice(0, 24);
  await store.ensureBucket(store.bucket, {
    workspaceId,
    knowledgeSpaceId: spaceId,
    requestId: context.requestId,
    traceId: context.traceId,
  });
  const repository = new KnowledgeObjectRefRepository(connection);
  const permission = { denyWrite: false, denyRead: false };
  const catalog = {
    async getSpace(id: string) {
      return { id, knowledgeSpaceId: id };
    },
  } as unknown as CatalogPort;
  const access = {
    async assertPermission(resourceType: string, _resourceId: string, action: string) {
      if (permission.denyWrite && action === 'write') {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_FORBIDDEN',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { resourceType, action },
        });
      }
      if (permission.denyRead && action === 'read') {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_FORBIDDEN',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { resourceType, action },
        });
      }
      return { allowed: true };
    },
  } as unknown as AccessPort;
  const files = new FileApplication(
    repository,
    store as unknown as ObjectStoreApplicationPort,
    catalog,
    access,
    new FileTicketService(TICKET_SECRET, 'http://127.0.0.1:3010'),
    new ObjectStoreArchiveSafetyAdapter(store),
  );
  const env: B06aEnv = {
    suffix,
    workspaceId,
    otherWorkspaceId,
    memberId,
    spaceId,
    otherSpaceId,
    context,
    otherContext,
    connection,
    store,
    repository,
    files,
    objects: new Set<string>(),
    permission,
    storageContext(space = spaceId) {
      return {
        workspaceId,
        knowledgeSpaceId: space,
        requestId: context.requestId,
        traceId: context.traceId,
      };
    },
    track(ref) {
      if (!ref) return;
      for (const key of [ref.objectKey, ref.pendingObjectKey, ref.finalObjectKey]) {
        if (typeof key === 'string' && key.length > 0) env.objects.add(key);
      }
    },
    async cleanup() {
      const refs = await connection.models.KnowledgeObjectRef.find({
        workspaceId: { $in: [workspaceId, otherWorkspaceId] },
      }).lean();
      for (const ref of refs) {
        for (const key of [
          ref.objectKey,
          ref.upload?.pendingObjectKey,
          ref.upload?.finalObjectKey,
        ]) {
          if (typeof key === 'string' && key.length > 0) env.objects.add(key);
        }
      }
      for (const key of env.objects) {
        await store
          .deleteObject(key, {
            workspaceId,
            knowledgeSpaceId: spaceId,
            requestId: context.requestId,
            traceId: context.traceId,
          })
          .catch(() => undefined);
      }
      for (const entry of KNOWLEDGE_SCHEMA_REGISTRY) {
        const model = connection.models[entry.modelName];
        if (model) {
          await model.deleteMany({ workspaceId: { $in: [workspaceId, otherWorkspaceId] } });
        }
      }
      await connection.close();
    },
  };
  return env;
}

export interface UploadResult {
  uploadId: string;
  ref: ObjectRefView;
  completed: ObjectRefView;
}

export async function uploadBuffer(
  env: B06aEnv,
  input: {
    name: string;
    mimeType: string;
    body: Buffer;
    context?: TenantContext;
    spaceId?: string;
    complete?: boolean;
  },
): Promise<UploadResult> {
  const context = input.context ?? env.context;
  const targetSpace = input.spaceId ?? env.spaceId;
  const session = await env.files.init(
    {
      knowledgeSpaceId: targetSpace,
      name: input.name,
      mimeType: input.mimeType,
      sizeBytes: input.body.byteLength,
    },
    context,
  );
  const ref = await env.repository.findObjectRef(session.uploadId, context);
  if (!ref) throw new Error('upload ref missing');
  env.track(ref);
  const parts: Array<{ partNumber: number; etag: string }> = [];
  if (session.mode === 'single') {
    const presigned = await env.files.presign(session.uploadId, { partNumbers: [1] }, context);
    const response = await fetch(presigned.uploads[0]!.url, {
      method: 'PUT',
      headers: presigned.uploads[0]!.headers,
      body: input.body,
    });
    if (response.status !== 200) {
      throw new Error('single PUT failed with status ' + response.status);
    }
  } else {
    for (let partNumber = 1; partNumber <= session.partCount; partNumber += 1) {
      const offset = (partNumber - 1) * session.partSizeBytes;
      const chunk = input.body.subarray(
        offset,
        Math.min(offset + session.partSizeBytes, input.body.byteLength),
      );
      parts.push(await env.files.uploadPart(session.uploadId, partNumber, chunk, context));
    }
  }
  if (input.complete === false) {
    return { uploadId: session.uploadId, ref, completed: ref };
  }
  const completed = await env.files.complete({ uploadId: session.uploadId, parts }, context);
  env.track(completed);
  return { uploadId: session.uploadId, ref, completed };
}

export function errorCode(error: unknown): string {
  const problem = (error as { problem?: { error?: { code?: string } } }).problem;
  return problem?.error?.code ?? 'NO_PROBLEM';
}
