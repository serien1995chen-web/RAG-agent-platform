import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeError } from '../../packages/contracts/src';
import {
  ArchiveSafetyInspector,
  ArchiveSafetySourceError,
} from '../../packages/parse/src/archive-safety';
import { ObjectLifecycleService } from '../../packages/service/src/modules/knowledge/application/object-lifecycle';
import type {
  ObjectRefRepositoryPort,
  ObjectRefView,
} from '../../packages/service/src/modules/knowledge/application/ports';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

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
