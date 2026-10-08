import { describe, expect, it } from 'vitest';
import { SearchRequestSchema, SearchResultSchema } from '../../packages/contracts/src/index';
import {
  DatasetApiService,
  createDegradedDatasetSearchPort,
  type DatasetSummaryValue,
  type RequestContext,
} from '../../packages/service/src/index';

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
});
