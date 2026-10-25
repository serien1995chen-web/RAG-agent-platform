import { KnowledgeApiError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type {
  ObjectRefRepositoryPort,
  ObjectRefView,
  ObjectStorageContext,
  ObjectStoreApplicationPort,
} from './ports';

export interface ObjectCleanupResult {
  scanned: number;
  eligible: number;
  deleted: number;
  retryable: number;
  failed: number;
}

function storageContext(ref: ObjectRefView, context: TenantContext): ObjectStorageContext {
  return {
    workspaceId: context.workspaceId,
    knowledgeSpaceId: ref.knowledgeSpaceId,
    requestId: context.requestId,
    traceId: context.traceId,
  };
}

export class ObjectLifecycleService {
  constructor(
    private readonly objectRefs: ObjectRefRepositoryPort,
    private readonly objectStore: ObjectStoreApplicationPort,
    private readonly batchSize = 500,
  ) {}

  async cleanup(context: TenantContext, now: Date = new Date()): Promise<ObjectCleanupResult> {
    const result: ObjectCleanupResult = {
      scanned: 0,
      eligible: 0,
      deleted: 0,
      retryable: 0,
      failed: 0,
    };
    const candidates = await this.objectRefs.findCleanupCandidates(this.batchSize, now, context);
    result.scanned = candidates.length;

    for (const candidate of candidates) {
      if (await this.objectRefs.hasActiveSourceReference(candidate.blobId, context)) {
        continue;
      }
      if (candidate.state === 'active' && candidate.purpose !== 'export') {
        continue;
      }
      if (candidate.state === 'active' && candidate.expiresAt === null) {
        continue;
      }
      if (candidate.state === 'active' && Date.parse(candidate.expiresAt!) > now.getTime()) {
        continue;
      }
      if (candidate.state === 'pending' && candidate.expiresAt === null) {
        continue;
      }
      if (candidate.state === 'pending' && Date.parse(candidate.expiresAt!) > now.getTime()) {
        continue;
      }
      result.eligible += 1;

      let deleting = candidate;
      try {
        if (candidate.state !== 'deleting') {
          deleting = await this.objectRefs.markDeleting(
            candidate.blobId,
            candidate.version,
            context,
          );
        }
        await this.objectStore.deleteObject(deleting.objectKey, storageContext(deleting, context));
        await this.objectRefs.confirmDeleted(deleting.blobId, deleting.version, context);
        result.deleted += 1;
      } catch (error) {
        if (
          error instanceof KnowledgeApiError &&
          error.problem.error.code === 'KNOWLEDGE_NOT_FOUND'
        ) {
          try {
            const current = await this.objectRefs.findObjectRef(deleting.blobId, context);
            if (current?.state === 'deleted') {
              result.deleted += 1;
              continue;
            }
            if (current) {
              await this.objectRefs.confirmDeleted(current.blobId, current.version, context);
              result.deleted += 1;
              continue;
            }
          } catch {
            result.retryable += 1;
            continue;
          }
        }
        if (
          error instanceof KnowledgeApiError &&
          (error.problem.error.code === 'KNOWLEDGE_CONFLICT' ||
            error.problem.error.code === 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE' ||
            error.problem.error.code === 'KNOWLEDGE_DEPENDENCY_TIMEOUT')
        ) {
          result.retryable += 1;
          continue;
        }
        result.failed += 1;
      }
    }
    return result;
  }
}
