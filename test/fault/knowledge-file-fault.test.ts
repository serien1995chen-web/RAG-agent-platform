import { describe, expect, it, vi } from 'vitest';
import type { RouteEntry } from '../../packages/contracts/src';
import { createKnowledgeError } from '../../packages/contracts/src';
import {
  ArchiveSafetyInspector,
  ArchiveSafetySourceError,
} from '../../packages/parse/src/archive-safety';
import { ObjectLifecycleService } from '../../packages/service/src/modules/knowledge/application/object-lifecycle';
import { RedisKnowledgeRateLimiter } from '../../packages/service/src/modules/knowledge/adapter/rate-limit.adapter';
import type {
  ObjectRefRepositoryPort,
  ObjectRefView,
} from '../../packages/service/src/modules/knowledge/application/ports';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';
import { ticketRateLimitScope } from '../../projects/app/src/shared/knowledge-api/handler';

const context: TenantContext = {
  workspaceId: 'ws_fault',
  memberId: 'member',
  requestId: 'request',
  traceId: 'trace',
  scopes: ['knowledge:admin'],
};

const ref: ObjectRefView = {
  blobId: '65f1e5b2a1c9d4b7e8f09abc',
  workspaceId: context.workspaceId,
  knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
  provider: 'minio',
  bucket: 'kb-test',
  objectKey: 'ws/ws_fault/space/65f1e5b2a1c9d4b7e8f01234/source/unbound/source/blob/file.txt',
  providerUploadId: null,
  uploadMode: 'single',
  uploadStatus: 'uploading',
  pendingObjectKey:
    'ws/ws_fault/space/65f1e5b2a1c9d4b7e8f01234/source/unbound/pending/blob/file.txt',
  finalObjectKey: 'ws/ws_fault/space/65f1e5b2a1c9d4b7e8f01234/source/unbound/final/blob/file.txt',
  finalizedAt: null,
  pendingUrlExpiresAt: new Date(0).toISOString(),
  originalName: 'file.txt',
  purpose: 'source',
  sourceId: null,
  mimeType: 'text/plain',
  sizeBytes: 5,
  etag: 'etag',
  sha256: 'sha',
  state: 'pending',
  expiresAt: new Date(0).toISOString(),
  version: 1,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  deletedAt: null,
};

describe('TEST-FILE-005-BLOCK lifecycle fault', () => {
  it('TEST-FILE-005-T04 keeps deleting state when the provider fails', async () => {
    const deleting = { ...ref, state: 'deleting' as const, version: 2 };
    const repository = {
      findCleanupCandidates: vi.fn().mockResolvedValue([ref]),
      hasActiveSourceReference: vi.fn().mockResolvedValue(false),
      markDeleting: vi.fn().mockResolvedValue(deleting),
      confirmDeleted: vi.fn(),
    } as unknown as ObjectRefRepositoryPort;
    const objectStore = {
      deleteObject: vi.fn().mockRejectedValue(
        createKnowledgeError({
          code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
          requestId: 'request',
          traceId: 'trace',
        }),
      ),
    };
    const service = new ObjectLifecycleService(repository, objectStore as never, 500);
    const result = await service.cleanup(context);
    expect(result.retryable).toBe(1);
    expect(repository.confirmDeleted).not.toHaveBeenCalled();
  });

  it('TEST-FILE-005-T08 aborts expired multipart state before deleting the object', async () => {
    const expired: ObjectRefView = {
      ...ref,
      providerUploadId: 'provider-upload-1',
      uploadMode: 'multipart',
      uploadStatus: 'uploading',
    };
    const deleting = { ...expired, state: 'deleting' as const, version: 2 };
    const repository = {
      findCleanupCandidates: vi.fn().mockResolvedValue([expired]),
      hasActiveSourceReference: vi.fn().mockResolvedValue(false),
      markDeleting: vi.fn().mockResolvedValue(deleting),
      confirmDeleted: vi.fn().mockResolvedValue({ ...deleting, state: 'deleted' }),
    } as unknown as ObjectRefRepositoryPort;
    const abortMultipartUpload = vi.fn().mockResolvedValue({ aborted: true });
    const deleteObject = vi.fn().mockResolvedValue({ deleted: true });
    const service = new ObjectLifecycleService(
      repository,
      { abortMultipartUpload, deleteObject } as never,
      500,
    );
    const result = await service.cleanup(context);
    expect(result.deleted).toBe(1);
    expect(abortMultipartUpload).toHaveBeenCalledWith(
      expired.objectKey,
      'provider-upload-1',
      expect.any(Object),
    );
    expect(deleteObject).toHaveBeenCalled();
    expect(abortMultipartUpload.mock.invocationCallOrder[0]).toBeLessThan(
      deleteObject.mock.invocationCallOrder[0]!,
    );
  });

  it('TEST-FILE-005-T10 continues to finalKey when pendingKey deletion returns 404', async () => {
    const pendingObjectKey = ref.pendingObjectKey!;
    const finalObjectKey = ref.finalObjectKey!;
    const deleting = {
      ...ref,
      objectKey: pendingObjectKey,
      state: 'deleting' as const,
      version: 2,
    };
    const repository = {
      findCleanupCandidates: vi.fn().mockResolvedValue([deleting]),
      hasActiveSourceReference: vi.fn().mockResolvedValue(false),
      confirmDeleted: vi.fn().mockResolvedValue({ ...deleting, state: 'deleted' }),
    } as unknown as ObjectRefRepositoryPort;
    const deleteObject = vi.fn(async (key: string) => {
      if (key === pendingObjectKey) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_NOT_FOUND',
          requestId: 'request',
          traceId: 'trace',
        });
      }
      return { deleted: true };
    });
    const service = new ObjectLifecycleService(repository, { deleteObject } as never, 500);
    const result = await service.cleanup(context);
    expect(result.deleted).toBe(1);
    expect(deleteObject.mock.calls.map(([key]) => key)).toEqual([pendingObjectKey, finalObjectKey]);
    expect(repository.confirmDeleted).toHaveBeenCalledTimes(1);
  });
});

describe('TEST-FILE-003-BLOCK ticket rate limit isolation', () => {
  it('TEST-FILE-003-F06 isolates invalid tickets from workspace and ticket buckets', async () => {
    const counts = new Map<string, number>();
    const redis = {
      async eval(_script: string, _keys: number, key: string) {
        const used = (counts.get(key) ?? 0) + 1;
        counts.set(key, used);
        return [used, 1000];
      },
    };
    const limiter = new RedisKnowledgeRateLimiter(redis as never);
    const route = {
      operationId: 'API-FILE-CONTENT',
      rateLimit: '2 QPS/IP',
    } as RouteEntry;
    const first = ticketRateLimitScope('invalid-ticket-a');
    const second = ticketRateLimitScope('invalid-ticket-b');
    expect(first).not.toContain('invalid-ticket-a');
    expect(first).not.toBe(second);

    await limiter.consume({ workspaceId: first, route });
    await limiter.consume({ workspaceId: first, route });
    const exhausted = await limiter.consume({ workspaceId: first, route });
    const independent = await limiter.consume({ workspaceId: second, route });
    expect(exhausted?.allowed).toBe(false);
    expect(independent?.allowed).toBe(true);
  });
});

describe('TEST-FILE-004-A16 archive safety fault', () => {
  it('fails closed for provider range failures without returning safe', async () => {
    for (const category of ['dependency_unavailable', 'dependency_timeout'] as const) {
      const result = await new ArchiveSafetyInspector().inspect({
        originalName: 'archive.zip',
        container: 'zip',
        source: {
          size: 1024,
          async readRange() {
            throw new ArchiveSafetySourceError(category);
          },
        },
      });
      expect(result.safe).toBe(false);
      expect(result.status).toBe(category);
    }
  });
});
