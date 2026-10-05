import { describe, expect, it } from 'vitest';
import {
  ApiErrorException,
  ImportSourceService,
  InsertDataService,
  PushDataService,
  createDefaultPorts,
} from '../../packages/service/src/index';
import type { KnowledgeItemSnapshot, RequestContext } from '../../packages/service/src/index';

const context: RequestContext = {
  requestId: 'req-write-path',
  tenant: { teamId: 'team-a', tmbId: 'tmb-a', authType: 'token', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: false },
};

const ports = createDefaultPorts();

const importSource = new ImportSourceService({
  collections: ports.collectionRepository,
  sourceProvider: ports.datasetSourceProvider,
  trainingProcessor: ports.trainingProcessor,
});
const insertData = new InsertDataService({
  items: ports.knowledgeItemRepository,
  vectors: ports.vectorController,
  fullText: ports.fullTextStore,
});
const pushData = new PushDataService({
  jobs: ports.processingJobRepository,
  trainingProcessor: ports.trainingProcessor,
});

describe('三条写入路径（设计文档 1.5 / 8.2 / 8.3）', () => {
  it('路径 A/B/C 可区分且不得相互伪装', () => {
    expect(importSource.pathKind).toBe('source-import');
    expect(importSource.usesParser).toBe(true);
    expect(importSource.usesTrainingQueue).toBe(true);

    expect(insertData.pathKind).toBe('direct-insert');
    expect(insertData.usesParser).toBe(false);
    expect(insertData.usesTrainingQueue).toBe(false);

    expect(pushData.pathKind).toBe('queue-push');
    expect(pushData.usesParser).toBe(false);
    expect(pushData.usesTrainingQueue).toBe(true);
  });

  it('默认 Port 下三条路径返回稳定未实现错误', async () => {
    await expect(
      importSource.previewSource(
        { datasetId: 'd', sourceType: 'file', sourceRef: 'f', options: { timeoutMs: 1 } },
        context,
      ),
    ).rejects.toBeInstanceOf(ApiErrorException);

    const item: KnowledgeItemSnapshot = {
      dataId: 'data-1',
      teamId: 'team-a',
      datasetId: 'd',
      collectionId: 'c',
      q: 'question',
      indexes: [],
      rebuilding: false,
      version: 1,
      createTime: '2026-10-05T00:00:00Z',
      updateTime: '2026-10-05T00:00:00Z',
    };
    await expect(
      insertData.insertItem({ item, options: { timeoutMs: 1 } }, context),
    ).rejects.toBeInstanceOf(ApiErrorException);

    await expect(
      pushData.enqueueJob(
        {
          job: {
            jobId: 'team-a:d:parse:1',
            teamId: 'team-a',
            datasetId: 'd',
            mode: 'parse',
            expireAt: null,
          },
          options: { timeoutMs: 1 },
        },
        context,
      ),
    ).rejects.toBeInstanceOf(ApiErrorException);
  });
});
