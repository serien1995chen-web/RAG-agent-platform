import { ApiErrorException, createApiError } from '../../packages/contracts/src/index';
import { describe, expect, it } from 'vitest';
import { ImportSourceService } from '../../packages/service/src/index';
import type { RequestContext } from '../../packages/service/src/ports/types';

const context: RequestContext = {
  requestId: 'req-ingest-fault',
  tenant: { teamId: 'team-a', tmbId: 'tmb-a', authType: 'token', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: false },
};

const collection = {
  teamId: 'team-a',
  datasetId: 'dataset-a',
  parentId: null,
  type: 'file',
  name: 'n',
  tagIds: [],
  sourceRef: 'ref',
};

describe('P4-12 ingest fault classification', () => {
  it('surfaces parser failures as stable errors and does not fabricate success', async () => {
    const service = new ImportSourceService({
      collections: { create: async () => ({ collectionId: 'c1' }) } as never,
      sourceProvider: {
        read: async () => {
          throw new ApiErrorException(
            createApiError({ code: 501057, requestId: context.requestId, params: {} }),
          );
        },
        preview: async () => {
          throw new Error('unused');
        },
      },
      trainingProcessor: { process: async () => ({ state: 'success' }) },
    });
    let created = 0;
    const tracked = new ImportSourceService({
      collections: {
        create: async () => {
          created += 1;
          return { collectionId: 'c1' };
        },
      } as never,
      sourceProvider: {
        read: async () => {
          throw new ApiErrorException(
            createApiError({ code: 501057, requestId: context.requestId, params: {} }),
          );
        },
        preview: async () => ({ rawText: '', contentHash: 'x' }),
      },
      trainingProcessor: { process: async () => ({ state: 'success' }) },
    });
    await expect(
      service.createCollectionFromSource(
        { collection, sourceType: 'file', sourceRef: 'f', options: { timeoutMs: 1 } },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501057 } });
    await expect(
      tracked.createCollectionFromSource(
        { collection, sourceType: 'file', sourceRef: 'f', options: { timeoutMs: 1 } },
        context,
      ),
    ).rejects.toBeInstanceOf(ApiErrorException);
    expect(created).toBe(0);
  });

  it('does not enqueue when QueuePort is missing (501062 before side effects)', async () => {
    let created = 0;
    const service = new ImportSourceService({
      collections: {
        create: async () => {
          created += 1;
          return { collectionId: 'c1' };
        },
      } as never,
      sourceProvider: {
        read: async () => ({ rawText: 'content', contentHash: 'h' }),
        preview: async () => ({ rawText: 'content', contentHash: 'h' }),
      },
      trainingProcessor: { process: async () => ({ state: 'success' }) },
    });
    await expect(
      service.createCollectionFromSource(
        { collection, sourceType: 'text', sourceRef: 'c', options: { timeoutMs: 1 } },
        context,
      ),
    ).rejects.toMatchObject({ error: { code: 501062 } });
    expect(created).toBe(0);
  });
});
