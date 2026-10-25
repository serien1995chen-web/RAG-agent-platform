import type { Connection } from 'mongoose';
import {
  KnowledgeObjectRefRepository,
  ObjectLifecycleService,
  registerKnowledgeModels,
  resolveSecretRef,
  type KnowledgeRuntimeConfig,
  type TenantContext,
} from '@kb/service';
import { MinioKnowledgeObjectStore } from '@kb/storage/providers/minio';

export interface FileCleanupCycleInput {
  connection: Connection;
  config: KnowledgeRuntimeConfig;
  instanceId: string;
}

export interface FileCleanupCycle {
  runOnce(): Promise<{
    scanned: number;
    eligible: number;
    deleted: number;
    retryable: number;
    failed: number;
  }>;
}

export function createFileCleanupCycle(input: FileCleanupCycleInput): FileCleanupCycle {
  const endpoint = new URL(input.config.s3.endpoint);
  const objectStore = new MinioKnowledgeObjectStore({
    provider: 'minio',
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
    useSSL: endpoint.protocol === 'https:',
    accessKey: resolveSecretRef(input.config.s3.accessKeyRef),
    secretKey: resolveSecretRef(input.config.s3.secretKeyRef),
    region: input.config.s3.region,
    bucket: input.config.s3.bucket,
    credentialRefs: input.config.s3.credentialRefs,
  });
  const objectRefs = new KnowledgeObjectRefRepository(input.connection);
  const lifecycle = new ObjectLifecycleService(objectRefs, objectStore, 500);
  const model = registerKnowledgeModels(input.connection).KnowledgeObjectRef;

  return {
    async runOnce() {
      const totals = {
        scanned: 0,
        eligible: 0,
        deleted: 0,
        retryable: 0,
        failed: 0,
      };
      const workspaces = await model.distinct('workspaceId', {
        deletedAt: null,
        $or: [
          { state: 'deleting' },
          { state: 'pending', expiresAt: { $ne: null, $lte: new Date() } },
          {
            state: 'active',
            purpose: 'export',
            expiresAt: { $ne: null, $lte: new Date() },
          },
        ],
      });
      for (const workspaceId of workspaces) {
        if (typeof workspaceId !== 'string') continue;
        const context: TenantContext = {
          workspaceId,
          memberId: 'system:file-worker',
          requestId: `file-cleanup:${Date.now()}`,
          traceId: `file-worker:${input.instanceId}`,
          scopes: ['knowledge:admin'],
        };
        const result = await lifecycle.cleanup(context);
        totals.scanned += result.scanned;
        totals.eligible += result.eligible;
        totals.deleted += result.deleted;
        totals.retryable += result.retryable;
        totals.failed += result.failed;
      }
      return totals;
    },
  };
}
