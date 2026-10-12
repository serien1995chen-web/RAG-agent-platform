import { describe, expect, it } from 'vitest';
import { ApiErrorException } from '../../packages/contracts/src/index';
import {
  createDefaultDocumentParser,
  type DocumentParseContext,
} from '../../packages/parse/src/index';
import {
  createSkeletonError,
  ImportSourceService,
  type DatasetSourceProvider,
  type RequestContext,
  type SourceReadResult,
} from '../../packages/service/src/index';

const context: RequestContext = {
  requestId: 'req-ingest-fault',
  tenant: {
    teamId: '000000000000000000000001',
    tmbId: '000000000000000000000002',
    authType: 'internal',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: false },
};

/** TEST-FI-INGEST-001 故障分类与无残留。 */
describe('TEST-FI-INGEST-001 ingest fault classification', () => {
  it('classifies an unsupported parser format as 501056 and never fakes success', async () => {
    const parseRequest: DocumentParseContext = {
      teamId: context.tenant.teamId,
      datasetId: '0000000000000000000000d1',
      fileRef: 'file.unknown',
      extension: 'unknown',
      timeoutMs: 1_000,
      bytes: Buffer.from('x', 'utf8'),
    };
    await expect(createDefaultDocumentParser().parse(parseRequest)).rejects.toMatchObject({
      error: { code: 501056 },
    });
  });

  it('does not create a collection when the source provider fails (no orphan)', async () => {
    let created = 0;
    const provider: DatasetSourceProvider = {
      read: async (): Promise<SourceReadResult> => {
        throw new ApiErrorException(
          createSkeletonError({ operation: 'source.read' }, context.requestId),
        );
      },
      preview: async (): Promise<SourceReadResult> => {
        throw new ApiErrorException(
          createSkeletonError({ operation: 'source.preview' }, context.requestId),
        );
      },
    };
    const service = new ImportSourceService({
      collections: {
        create: async () => {
          created += 1;
          return { collectionId: 'c1' };
        },
        list: async () => ({ total: 0, list: [], cursor: null }),
        update: async () => ({ version: 1 }),
        deleteTree: async () => ({ deleteJobId: 'd1' }),
      },
      sourceProvider: provider,
      trainingProcessor: { process: async () => ({ state: 'success' }) },
    });
    await expect(
      service.createCollectionFromSource(
        {
          collection: {
            teamId: context.tenant.teamId,
            datasetId: '0000000000000000000000d1',
            parentId: null,
            type: 'file',
            name: 'f',
            tagIds: [],
          },
          sourceType: 'file',
          sourceRef: 'dataset/d1/a.md',
          options: { timeoutMs: 1_000 },
        },
        context,
      ),
    ).rejects.toBeInstanceOf(ApiErrorException);
    expect(created).toBe(0);
  });
});
