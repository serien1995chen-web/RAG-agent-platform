import { ApiErrorException, createApiError } from '@kb/contracts';
import {
  QUEUE_NAMES,
  buildChunkJobId,
  buildParseJobId,
  buildSyncJobId,
  type QueuePort,
} from '@kb/dal';
import type { DatasetSyncPort, SyncResult } from '../../../ports/capabilities';
import type {
  CollectionRepository,
  KnowledgeBaseRepository,
  ProcessingJobRepository,
} from '../../../ports/repositories';
import type { CollectionSnapshot, PortCallOptions, RequestContext } from '../../../ports/types';

const SYNCABLE_COLLECTION_TYPES = new Set(['link', 'apiFile']);
const COLLECTION_PAGE_SIZE = 100;

type CollectionLookupRepository = CollectionRepository & {
  get(
    input: { collectionId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<CollectionSnapshot>;
};

export interface DatasetSyncServiceDeps {
  collections: CollectionLookupRepository;
  knowledgeBase: KnowledgeBaseRepository;
  processingJobs: ProcessingJobRepository;
  queue: QueuePort;
}

interface SyncJobData {
  mode: string;
  teamId: string;
  datasetId: string;
  collectionId: string;
  payload: Record<string, unknown>;
}

function unsupportedCollectionType(type: string, requestId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501019,
      requestId,
      params: { provider: 'collection', status: type },
    }),
  );
}

/**
 * Dataset Sync 应用服务（设计 8.9 / 9.13 / 12.10）：
 * 手动同步先写 autoSync 事实，再按稳定 sync jobId 投递；扫描同步逐条写任务事实后投递。
 */
export class DatasetSyncApplicationService implements DatasetSyncPort {
  constructor(private readonly deps: DatasetSyncServiceDeps) {}

  async enqueueManualSync(
    input: { collectionId: string; idempotencyKey: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ jobId: string }> {
    const collection = await this.deps.collections.get(
      { collectionId: input.collectionId, options: input.options },
      context,
    );
    if (!SYNCABLE_COLLECTION_TYPES.has(collection.type)) {
      throw unsupportedCollectionType(collection.type, context.requestId);
    }

    const dataset = await this.deps.knowledgeBase.get(
      { datasetId: collection.datasetId, options: input.options },
      context,
    );
    if (!dataset.autoSync) {
      await this.deps.knowledgeBase.update(
        {
          datasetId: dataset.datasetId,
          version: dataset.version,
          patch: { autoSync: true },
          options: input.options,
        },
        context,
      );
    }

    const jobId = buildSyncJobId(context.tenant.teamId, dataset.datasetId);
    const result = await this.deps.queue.enqueue(
      QUEUE_NAMES.sync,
      jobId,
      {
        datasetId: dataset.datasetId,
        idempotencyKey: input.idempotencyKey,
      },
      { attempts: 3 },
    );
    return { jobId: result.jobId };
  }

  async sync(
    input: { datasetId: string; idempotencyKey: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<SyncResult> {
    let changed = 0;
    let failed = 0;
    let page = 1;

    while (true) {
      const result = await this.deps.collections.list(
        {
          datasetId: input.datasetId,
          page,
          limit: COLLECTION_PAGE_SIZE,
          options: input.options,
        },
        context,
      );
      for (const collection of result.list) {
        if (!SYNCABLE_COLLECTION_TYPES.has(collection.type)) continue;
        try {
          await this.enqueueCollectionSync(collection, input.idempotencyKey, context);
          changed += 1;
        } catch {
          failed += 1;
        }
      }
      if (result.list.length === 0 || page * COLLECTION_PAGE_SIZE >= result.total) break;
      page += 1;
    }

    if (failed > 0) {
      return { state: 'error', changed, removed: 0, errorMsg: 'dataset.sync.partial_failure' };
    }
    return { state: 'active', changed, removed: 0 };
  }

  private async enqueueCollectionSync(
    collection: CollectionSnapshot,
    idempotencyKey: string,
    context: RequestContext,
  ): Promise<void> {
    const options = { timeoutMs: context.timeoutMs ?? 5_000 };
    const version = collection.version;
    const parseJobId = buildParseJobId(
      context.tenant.teamId,
      collection.datasetId,
      collection.collectionId,
      version,
    );
    const chunkJobId = buildChunkJobId(
      context.tenant.teamId,
      collection.datasetId,
      collection.collectionId,
      version,
    );

    await this.enqueueTrainingJob(
      {
        jobId: parseJobId,
        mode: 'parse',
        collection,
        version,
        idempotencyKey,
        options,
      },
      context,
    );
    await this.enqueueTrainingJob(
      {
        jobId: chunkJobId,
        mode: 'chunk',
        collection,
        version,
        idempotencyKey,
        options,
      },
      context,
    );
  }

  private async enqueueTrainingJob(
    input: {
      jobId: string;
      mode: 'parse' | 'chunk';
      collection: CollectionSnapshot;
      version: number;
      idempotencyKey: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<void> {
    const task = await this.deps.processingJobs.enqueue(
      {
        job: {
          jobId: input.jobId,
          teamId: context.tenant.teamId,
          datasetId: input.collection.datasetId,
          collectionId: input.collection.collectionId,
          mode: input.mode,
          expireAt: null,
          weight: 0,
        },
        options: input.options,
      },
      context,
    );
    const data: SyncJobData = {
      mode: input.mode,
      teamId: context.tenant.teamId,
      datasetId: input.collection.datasetId,
      collectionId: input.collection.collectionId,
      payload: {
        taskId: task.taskId,
        version: input.version,
        idempotencyKey: input.idempotencyKey,
      },
    };
    await this.deps.queue.enqueue(
      input.mode === 'parse' ? QUEUE_NAMES.parse : QUEUE_NAMES.chunk,
      input.jobId,
      data,
      {
        attempts: 3,
      },
    );
  }
}
