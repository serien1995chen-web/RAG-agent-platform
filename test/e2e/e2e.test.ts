import { describe, expect, it } from 'vitest';
import { SearchRequestSchema, SearchResultSchema } from '../../packages/contracts/src/index';
import {
  DatasetApiService,
  createDegradedDatasetSearchPort,
  type DatasetSummaryValue,
  type RequestContext,
} from '../../packages/service/src/index';
import { ProcessingApplicationService } from '../../packages/service/src/modules/processing/application';
import { DatasetSyncApplicationService } from '../../packages/service/src/modules/collection/application/sync.service';
import type { QueuePort } from '../../packages/dal/src/queue-port';

const context: RequestContext = {
  requestId: 'req-e2e',
  tenant: {
    teamId: '000000000000000000000001',
    tmbId: '000000000000000000000002',
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const dataset: DatasetSummaryValue = {
  datasetId: '0000000000000000000000aa',
  teamId: context.tenant.teamId,
  name: 'e2e-demo',
  type: 'knowledge',
  parentId: null,
  vectorModel: 'bge-m3',
  indexVersion: 'bge-m3:1536:v1',
  inheritPermission: true,
  autoSync: false,
  deleteTime: null,
  version: 1,
  createTime: '2026-10-05T00:00:00.000Z',
  updateTime: '2026-10-05T00:00:00.000Z',
};

describe('E2E smoke: contract -> application -> projection adapter', () => {
  it('runs the Dataset create/list flow through the application service', async () => {
    const repository = {
      create: async () => ({ datasetId: dataset.datasetId, version: 1 }),
      updateDataset: async () => ({ version: 2 }),
      listByTeam: async () => ({ total: 1, list: [dataset] }),
      findByDatasetId: async () => dataset,
      countChildren: async () => 0,
    };
    const service = new DatasetApiService({ repository: repository as never });
    const created = await service.createDataset(
      { name: 'e2e-demo', type: 'dataset', vectorModel: 'bge-m3' },
      context,
    );
    expect(created.state).toBe('ready');
    const listed = await service.listDatasets({ page: 1, limit: 20 }, context);
    expect(listed.total).toBe(1);

    const updated = await service.updateDataset(
      { datasetId: dataset.datasetId, version: 1, autoSync: true },
      context,
    );
    expect(updated.version).toBe(2);
  });

  it('parses a SearchRequest and validates the SearchResult envelope', async () => {
    const request = SearchRequestSchema.parse({
      requestId: 'req-e2e',
      teamId: context.tenant.teamId,
      datasetIds: [dataset.datasetId],
      textQueries: ['hello'],
      models: { embeddingModel: 'bge-m3' },
    });
    const port = createDegradedDatasetSearchPort();
    const result = await port.search(request, context);
    expect(SearchResultSchema.parse(result)).toEqual(result);
  });

  it('projects task and sync results without a persisted completed state', async () => {
    const taskId = '0000000000000000000000bb';
    const collectionId = '0000000000000000000000cc';
    const processingRepository = {
      enqueue: async () => ({ taskId, jobId: 'job-a' }),
      claim: async () => ({ taskId, lockTime: '2026-10-10T00:00:00.000Z' }),
      renew: async () => ({ lockTime: '2026-10-10T00:00:00.000Z' }),
      finish: async () => undefined,
      finishWithLease: async () => undefined,
      resumeTask: async () => ({ taskId, retryCount: 3 }),
      getTaskDetail: async () => ({
        task: { taskId, derivedState: 'active' },
        derivedState: 'active',
      }),
      listTaskErrors: async () => ({ total: 0, list: [], cursor: null }),
      getQueueStats: async () => [{ mode: 'qa', depth: 1, running: 0 }],
      updateTrainingData: async () => ({ acceptedCount: 1 }),
      deleteTrainingData: async () => ({ deletedCount: 1 }),
      listCollectionErrors: async () => [],
      hasError: async () => false,
    };
    const processing = new ProcessingApplicationService({
      repository: processingRepository as never,
    });
    const detail = await processing.getTaskDetail(
      { taskId, options: { timeoutMs: 5_000 } },
      context,
    );
    expect(detail.derivedState).toBe('active');
    expect(JSON.stringify(detail)).not.toContain('completed');

    const queue: QueuePort = {
      enqueue: async (_queue, jobId) => ({ jobId, enqueued: true }),
      remove: async () => undefined,
      close: async () => undefined,
    };
    const sync = new DatasetSyncApplicationService({
      collections: {
        get: async () => ({
          collectionId,
          teamId: context.tenant.teamId,
          datasetId: dataset.datasetId,
          parentId: null,
          type: 'link',
          name: 'link',
          tagIds: [],
          version: 1,
          createTime: '2026-10-05T00:00:00.000Z',
          updateTime: '2026-10-05T00:00:00.000Z',
        }),
        list: async () => ({
          total: 1,
          list: [
            {
              collectionId,
              teamId: context.tenant.teamId,
              datasetId: dataset.datasetId,
              parentId: null,
              type: 'link',
              name: 'link',
              tagIds: [],
              version: 1,
              createTime: '2026-10-05T00:00:00.000Z',
              updateTime: '2026-10-05T00:00:00.000Z',
            },
          ],
          cursor: null,
        }),
        create: async () => ({ collectionId }),
        update: async () => ({ version: 2 }),
        deleteTree: async () => ({ deleteJobId: 'delete' }),
      },
      knowledgeBase: {
        get: async () => ({
          datasetId: dataset.datasetId,
          teamId: context.tenant.teamId,
          parentId: null,
          type: 'knowledge',
          name: dataset.name,
          vectorModel: dataset.vectorModel,
          inheritPermission: true,
          autoSync: true,
          deleteTime: null,
          version: 1,
          createTime: dataset.createTime,
          updateTime: dataset.updateTime,
        }),
        create: async () => ({ datasetId: dataset.datasetId, version: 1 }),
        update: async () => ({ version: 2 }),
        softDelete: async () => ({ deleteJobId: 'delete' }),
      },
      processingJobs: processingRepository as never,
      queue,
    });
    const syncResult = await sync.sync(
      { datasetId: dataset.datasetId, idempotencyKey: 'idem-e2e', options: { timeoutMs: 5_000 } },
      context,
    );
    expect(syncResult.state).toBe('active');
    expect(JSON.stringify(syncResult)).not.toContain('completed');
  });
});
