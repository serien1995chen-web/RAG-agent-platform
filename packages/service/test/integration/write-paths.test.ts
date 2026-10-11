import { ApiErrorException } from '@kb/contracts';
import {
  JOB_MODE_TO_QUEUE,
  QUEUE_NAMES,
  buildParseJobId,
  buildQaJobId,
  type QueuePort,
} from '@kb/dal';
import { describe, expect, it } from 'vitest';
import { ImportSourceService } from '../../src/modules/collection/application/import-source.service';
import { InsertDataService } from '../../src/modules/item/application/insert-data.service';
import { PushDataService } from '../../src/modules/processing/application/push-data.service';
import type {
  DatasetSourceProvider,
  FullTextStore,
  SourceReadRequest,
  SourceReadResult,
  TrainingProcessorPort,
  VectorController,
} from '../../src/ports/capabilities';
import type {
  CollectionRepository,
  KnowledgeItemRepository,
  ProcessingJobRepository,
} from '../../src/ports/repositories';
import type { RequestContext } from '../../src/ports/types';

const context: RequestContext = {
  requestId: 'req-1',
  tenant: { teamId: 'team-1', tmbId: 'tmb-1', authType: 'internal', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: false, isOwner: false },
};
const options = { timeoutMs: 5000 };

interface QueueCall {
  queue: string;
  jobId: string;
  payload: unknown;
}

function queueFake(calls: QueueCall[]): QueuePort {
  return {
    enqueue: async (queue, jobId, payload) => {
      calls.push({ queue, jobId, payload });
      return { jobId, enqueued: true };
    },
    remove: async () => undefined,
    close: async () => undefined,
  };
}

function collectionsFake(created: unknown[]): CollectionRepository {
  return {
    create: async (input) => {
      created.push(input.collection);
      return { collectionId: 'col-1' };
    },
    list: async () => ({ total: 0, list: [], cursor: null }),
    update: async () => ({ version: 2 }),
    deleteTree: async () => ({ deleted: 0 }),
  } as unknown as CollectionRepository;
}

function itemsFake(calls: string[]): KnowledgeItemRepository {
  return {
    bulkUpsert: async () => {
      calls.push('mongo');
      return { upserted: 1, duplicates: 0 };
    },
    updateIndexes: async () => ({ version: 2 }),
    deleteByScope: async () => ({ deleted: 0 }),
  } as unknown as KnowledgeItemRepository;
}

function vectorsFake(calls: string[]): VectorController {
  return {
    insert: async () => {
      calls.push('vector');
      return { inserted: 1 };
    },
    delete: async () => ({ deleted: 0 }),
    embRecall: async () => [],
    getVectorDataByTime: async () => [],
    getVectorCount: async () => 0,
  } as unknown as VectorController;
}

function fullTextFake(calls: string[]): FullTextStore {
  return {
    write: async () => {
      calls.push('fulltext');
    },
    search: async () => [],
    deleteByDataId: async () => ({ deleted: 0 }),
    deleteByDatasetIds: async () => ({ deleted: 0 }),
    deleteByCollectionIds: async () => ({ deleted: 0 }),
  } as unknown as FullTextStore;
}

function trainingProcessor(): TrainingProcessorPort {
  return { process: async () => ({ state: 'success', producedItems: 1 }) };
}

function sourceProvider(rawText: string, calls?: string[]): DatasetSourceProvider {
  const read = async (request: SourceReadRequest): Promise<SourceReadResult> => {
    calls?.push('read:' + request.sourceType);
    return { rawText, contentHash: 'sha256:' + request.sourceType };
  };
  return { read, preview: read };
}

function pushJobRepo(facts: string[]): ProcessingJobRepository {
  return {
    enqueue: async (input) => {
      facts.push('fact:' + input.job.jobId);
      return { taskId: 'task-' + input.job.jobId, jobId: input.job.jobId };
    },
    claim: async () => ({ taskId: 't', lockTime: 'l' }),
    renew: async () => ({ lockTime: 'l' }),
    finish: async () => undefined,
  } as unknown as ProcessingJobRepository;
}

const collectionInput = {
  teamId: 'team-1',
  datasetId: 'd',
  name: 'c',
  type: 'dataset',
  parentId: null,
  metadata: {},
} as never;

describe('TEST-FI-INGEST-001 path A source import', () => {
  it('preview has zero formal side effects', async () => {
    const created: unknown[] = [];
    const service = new ImportSourceService({
      collections: collectionsFake(created),
      sourceProvider: sourceProvider('正文'),
      trainingProcessor: trainingProcessor(),
    });
    const preview = await service.previewOnly(
      { datasetId: 'd', sourceType: 'text', sourceRef: '正文', options },
      context,
    );
    expect(preview.rawText).toBe('正文');
    expect(created).toHaveLength(0);
  });

  it('writes the Mongo fact then delivers the exact parse job to the queue', async () => {
    const created: unknown[] = [];
    const facts: string[] = [];
    const queued: QueueCall[] = [];
    const service = new ImportSourceService({
      collections: collectionsFake(created),
      sourceProvider: sourceProvider('正文'),
      trainingProcessor: trainingProcessor(),
      jobs: pushJobRepo(facts),
      queue: queueFake(queued),
    });
    const expectedJobId = buildParseJobId('team-1', 'd', 'col-1', 1);
    const result = await service.createCollectionFromSource(
      { collection: collectionInput, sourceType: 'text', sourceRef: '正文', options },
      context,
    );
    expect(result).toMatchObject({ status: 'ready', remainingTraining: 1, taskId: expectedJobId });
    expect(created).toHaveLength(1);
    expect(facts).toEqual(['fact:' + expectedJobId]);
    expect(queued).toEqual([
      {
        queue: JOB_MODE_TO_QUEUE.parse ?? QUEUE_NAMES.parse,
        jobId: expectedJobId,
        payload: { sourceType: 'text', contentHash: 'sha256:text' },
      },
    ]);
  });

  it('returns insertLen=0 ready without Task/Data for an empty import (TEST-INGEST-EMPTY-001)', async () => {
    const created: unknown[] = [];
    const facts: string[] = [];
    const queued: QueueCall[] = [];
    const service = new ImportSourceService({
      collections: collectionsFake(created),
      sourceProvider: sourceProvider('   \n  '),
      trainingProcessor: trainingProcessor(),
      jobs: pushJobRepo(facts),
      queue: queueFake(queued),
    });
    const result = await service.createCollectionFromSource(
      { collection: collectionInput, sourceType: 'text', sourceRef: '   ', options },
      context,
    );
    expect(result).toMatchObject({ insertLen: 0, remainingTraining: 0, status: 'ready' });
    expect(created).toHaveLength(1);
    expect(facts).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });

  it('fails with 501062 when the queue is not configured', async () => {
    const created: unknown[] = [];
    const service = new ImportSourceService({
      collections: collectionsFake(created),
      sourceProvider: sourceProvider('正文'),
      trainingProcessor: trainingProcessor(),
      jobs: pushJobRepo([]),
    });
    const error = await service
      .createCollectionFromSource(
        { collection: collectionInput, sourceType: 'text', sourceRef: '正文', options },
        context,
      )
      .catch((thrown: unknown) => thrown);
    expect((error as ApiErrorException).error.code).toBe(501062);
    // 预检先于副作用：缺 Queue 时不得创建 Collection。
    expect(created).toHaveLength(0);
  });
});

describe('TEST-FI-INSERT-001 path B direct insert', () => {
  it('writes vector before the Mongo transaction and emits after commit', async () => {
    const calls: string[] = [];
    const service = new InsertDataService({
      items: itemsFake(calls),
      vectors: vectorsFake(calls),
      fullText: fullTextFake(calls),
      withTransaction: async (work) => {
        calls.push('tx:begin');
        const result = await work();
        calls.push('tx:commit');
        return result;
      },
      emit: () => calls.push('event'),
    });
    const result = await service.insertDirect(
      {
        dataId: 'data-1',
        datasetId: 'd',
        collectionId: 'c',
        q: '  问题 ',
        a: '答案',
        vector: [0.1, 0.2],
        options,
      },
      context,
    );
    expect(result.inserted).toBe(1);
    expect(result.dedupKey).toMatch(/^qa:[0-9a-f]{64}$/);
    expect(calls).toEqual(['vector', 'tx:begin', 'mongo', 'fulltext', 'tx:commit', 'event']);
  });

  it('keeps a reconcilable orphan vector and emits no event when the Mongo transaction fails', async () => {
    const calls: string[] = [];
    const service = new InsertDataService({
      items: itemsFake(calls),
      vectors: vectorsFake(calls),
      fullText: fullTextFake(calls),
      withTransaction: async (work) => {
        calls.push('tx:begin');
        await work();
        throw new Error('mongo failed');
      },
    });
    await expect(
      service.insertDirect(
        { dataId: 'data-1', datasetId: 'd', collectionId: 'c', q: '问题', vector: [0.1], options },
        context,
      ),
    ).rejects.toThrow('mongo failed');
    expect(calls).toContain('vector');
    expect(calls).not.toContain('event');
  });

  it('rejects a pure image insert with 501038', async () => {
    const calls: string[] = [];
    const service = new InsertDataService({
      items: itemsFake(calls),
      vectors: vectorsFake(calls),
      fullText: fullTextFake(calls),
    });
    const error = await service
      .insertDirect(
        {
          dataId: 'data-1',
          datasetId: 'd',
          collectionId: 'c',
          q: '',
          imageId: 'img-1',
          vector: [0.1],
          options,
        },
        context,
      )
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApiErrorException);
    expect((error as ApiErrorException).error.code).toBe(501038);
    expect(calls).toHaveLength(0);
  });
});

describe('TEST-REP-PUSH-001 path C batch push', () => {
  it('writes the Mongo fact before delivering the exact stable job and dedupes repeats', async () => {
    const facts: string[] = [];
    const queued: QueueCall[] = [];
    const service = new PushDataService({
      jobs: pushJobRepo(facts),
      trainingProcessor: trainingProcessor(),
      queue: queueFake(queued),
    });
    const expected = buildQaJobId('team-1', 'data-1', 1);
    const result = await service.pushBatch(
      {
        datasetId: 'd',
        collectionId: 'c',
        mode: 'qa',
        items: [
          { dataId: 'data-1', version: 1, payload: { q: 'a' } },
          { dataId: 'data-1', version: 1, payload: { q: 'a' } },
          { dataId: 'data-2', version: 1, payload: { q: 'b' } },
        ],
        options,
      },
      context,
    );
    expect(result.accepted).toBe(2);
    expect(result.skipped).toBe(1);
    expect(facts).toEqual(['fact:' + expected, 'fact:' + buildQaJobId('team-1', 'data-2', 1)]);
    expect(queued).toEqual([
      { queue: JOB_MODE_TO_QUEUE.qa ?? QUEUE_NAMES.qa, jobId: expected, payload: { q: 'a' } },
      {
        queue: JOB_MODE_TO_QUEUE.qa ?? QUEUE_NAMES.qa,
        jobId: buildQaJobId('team-1', 'data-2', 1),
        payload: { q: 'b' },
      },
    ]);
  });

  it('fails with 501062 when the queue is not configured', async () => {
    const facts: string[] = [];
    const service = new PushDataService({
      jobs: pushJobRepo(facts),
      trainingProcessor: trainingProcessor(),
    });
    const error = await service
      .pushBatch(
        {
          datasetId: 'd',
          collectionId: 'c',
          mode: 'qa',
          items: [{ dataId: 'data-1', version: 1, payload: {} }],
          options,
        },
        context,
      )
      .catch((thrown: unknown) => thrown);
    expect((error as ApiErrorException).error.code).toBe(501062);
    // 预检先于副作用：缺 Queue 时不得写入 Mongo 训练任务事实。
    expect(facts).toHaveLength(0);
  });

  it('does not let enqueueJob bypass the queue (501062, no Mongo fact)', async () => {
    const facts: string[] = [];
    const service = new PushDataService({
      jobs: pushJobRepo(facts),
      trainingProcessor: trainingProcessor(),
    });
    const error = await service
      .enqueueJob(
        {
          job: { jobId: 'j1', teamId: 'team-1', datasetId: 'd', mode: 'qa', expireAt: null },
          options,
        },
        context,
      )
      .catch((thrown: unknown) => thrown);
    expect((error as ApiErrorException).error.code).toBe(501062);
    expect(facts).toHaveLength(0);
  });

  it('rejects an oversized batch without enqueuing', async () => {
    const facts: string[] = [];
    const queued: QueueCall[] = [];
    const service = new PushDataService({
      jobs: pushJobRepo(facts),
      trainingProcessor: trainingProcessor(),
      queue: queueFake(queued),
      maxItems: 2,
    });
    const error = await service
      .pushBatch(
        {
          datasetId: 'd',
          collectionId: 'c',
          mode: 'qa',
          items: [
            { dataId: 'd1', version: 1, payload: {} },
            { dataId: 'd2', version: 1, payload: {} },
            { dataId: 'd3', version: 1, payload: {} },
          ],
          options,
        },
        context,
      )
      .catch((thrown: unknown) => thrown);
    expect((error as ApiErrorException).error.code).toBe(501052);
    expect(facts).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });
});
