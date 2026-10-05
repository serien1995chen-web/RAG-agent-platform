import { describe, expect, it } from 'vitest';
import { ApiErrorException } from '../../packages/contracts/src/index';
import { DatasetApiService } from '../../packages/service/src/index';
import type {
  DatasetSummaryValue,
  KnowledgeBaseQueryRepository,
  RequestContext,
} from '../../packages/service/src/index';
import { createDefaultExtensionRegistry } from '../../projects/app/src/extensions/index';

const devIdentity = {
  teamId: '000000000000000000000001',
  tmbId: '000000000000000000000002',
};

const context: RequestContext = {
  requestId: 'req-extension-test',
  tenant: {
    teamId: devIdentity.teamId,
    tmbId: devIdentity.tmbId,
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const datasetSummary: DatasetSummaryValue = {
  datasetId: '0000000000000000000000aa',
  teamId: devIdentity.teamId,
  name: 'demo',
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

describe('non-Dataset extension points (9.1-9.4)', () => {
  it('enables the fixed dev identity only outside production', () => {
    const development = createDefaultExtensionRegistry({
      environment: 'development',
      devIdentity,
    });
    expect(development.isEnabled('identity')).toBe(true);
    expect(development.require<{ resolve: unknown }>('identity')).toBeDefined();

    const production = createDefaultExtensionRegistry({
      environment: 'production',
      devIdentity,
    });
    expect(production.isEnabled('identity')).toBe(false);
    expect(() => production.require('identity')).toThrow(ApiErrorException);
  });

  it('returns stable 501020 for agent/application/publish without guessing', () => {
    const registry = createDefaultExtensionRegistry({
      environment: 'development',
      devIdentity,
    });
    for (const id of ['agent', 'application', 'publish'] as const) {
      expect(registry.isEnabled(id)).toBe(false);
      let caught: unknown;
      try {
        registry.require(id);
      } catch (error) {
        caught = error;
      }
      const apiError = caught as ApiErrorException;
      expect(apiError.error.code).toBe(501020);
      expect(apiError.error.params.extension).toBe(id);
    }
  });

  it('keeps the Dataset core working when every extension is disabled (ACC-ARCH-004)', async () => {
    const repository: KnowledgeBaseQueryRepository & {
      create: (...args: never[]) => Promise<{ datasetId: string; version: number }>;
    } = {
      create: async () => ({ datasetId: datasetSummary.datasetId, version: 1 }),
      listByTeam: async () => ({ total: 1, list: [datasetSummary] }),
      findByDatasetId: async () => datasetSummary,
      countChildren: async () => 0,
    };
    const registry = createDefaultExtensionRegistry({
      environment: 'production',
      devIdentity: null,
    });
    expect(registry.isEnabled('identity')).toBe(false);
    expect(registry.isEnabled('agent')).toBe(false);

    const service = new DatasetApiService({ repository: repository as never });
    const listed = await service.listDatasets({ page: 1, limit: 20 }, context);
    expect(listed.total).toBe(1);
    expect(listed.list[0]?.name).toBe('demo');
    const detail = await service.getDatasetDetail(datasetSummary.datasetId, context);
    expect(detail.stats.collections).toBe(0);
  });
});
