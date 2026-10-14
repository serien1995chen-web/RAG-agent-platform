import { ApiErrorException, createApiError } from '@kb/contracts';
import { buildParseJobId } from '@kb/dal';
import type {
  FullTextStore,
  TaskResult,
  TenantQuotaProvider,
  TrainingProcessorPort,
  VectorController,
} from '../../../ports/capabilities';
import type { CollectionRepository, KnowledgeItemRepository } from '../../../ports/repositories';
import type { CollectionSnapshot, PortCallOptions, RequestContext } from '../../../ports/types';
import type { ChunkPolicyValue } from '../../../shared/persistence';

type RetrainCollectionRepository = CollectionRepository & {
  get(
    input: { collectionId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<CollectionSnapshot>;
};

interface CollectionRetrainServiceDeps {
  collections: RetrainCollectionRepository;
  items: KnowledgeItemRepository;
  fullText: FullTextStore;
  vectors: VectorController;
  processing: RetrainProcessingRuntime;
  trainingProcessor: TrainingProcessorPort;
  tenantQuota: TenantQuotaProvider;
}

interface RetrainProcessingRuntime {
  getQueueStats(
    input: { datasetId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<Array<{ mode: string; depth: number; running: number }>>;
  deleteTrainingData(
    input: { collectionId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ deletedCount: number }>;
  enqueueJob(
    input: {
      job: {
        jobId: string;
        teamId: string;
        datasetId: string;
        collectionId: string;
        mode: 'parse';
        expireAt: null;
      };
      budgetKind: 'initial';
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ taskId: string; jobId: string }>;
  finishJob(
    input: {
      taskId: string;
      state: 'success' | 'failed' | 'blocked' | 'final_error';
      errorMsg?: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<void>;
}

export interface CollectionRetrainInput {
  collectionId: string;
  policy: ChunkPolicyValue;
  idempotencyKey: string;
  options: PortCallOptions;
}

export interface CollectionRetrainResult {
  taskId: string;
}

export class CollectionRetrainService {
  constructor(private readonly deps: CollectionRetrainServiceDeps) {}

  async retrain(
    input: CollectionRetrainInput,
    context: RequestContext,
  ): Promise<CollectionRetrainResult> {
    if (!input.collectionId || !input.policy || !input.idempotencyKey) {
      throw new ApiErrorException(
        createApiError({
          code: 501069,
          requestId: context.requestId,
          params: { collectionId: input.collectionId, reason: 'invalid_retrain_input' },
        }),
      );
    }

    let collection: CollectionSnapshot;
    try {
      collection = await this.deps.collections.get(
        { collectionId: input.collectionId, options: input.options },
        context,
      );
    } catch (error) {
      if (error instanceof ApiErrorException && error.error.code === 501070) {
        throw retrainUnavailable(input.collectionId, 'collection_not_found', context.requestId);
      }
      throw error;
    }
    const queueStats = await this.deps.processing.getQueueStats(
      { datasetId: collection.datasetId, options: input.options },
      context,
    );
    if (queueStats.some((stats) => stats.depth > 0 || stats.running > 0)) {
      throw new ApiErrorException(
        createApiError({
          code: 501069,
          requestId: context.requestId,
          params: { collectionId: input.collectionId },
        }),
      );
    }

    const quota = await this.deps.tenantQuota.check(
      { operation: 'collection.retrain', amount: 1, options: input.options },
      context,
    );
    if (!quota.allowed) {
      throw new ApiErrorException(
        createApiError({
          code: 501071,
          requestId: context.requestId,
          params: {
            operation: 'collection.retrain',
            limit: quota.limit,
            current: quota.current,
          },
        }),
      );
    }

    const jobId = buildParseJobId(
      context.tenant.teamId,
      collection.datasetId,
      collection.collectionId,
      collection.version,
    );
    const enqueued = await this.deps.processing.enqueueJob(
      {
        job: {
          jobId,
          teamId: context.tenant.teamId,
          datasetId: collection.datasetId,
          collectionId: collection.collectionId,
          mode: 'parse',
          expireAt: null,
        },
        budgetKind: 'initial',
        options: input.options,
      },
      context,
    );
    const taskId = enqueued.taskId;
    const oldDerived = {
      datasetId: collection.datasetId,
      collectionId: collection.collectionId,
    };

    let trainingResult: TaskResult;
    try {
      trainingResult = await this.deps.trainingProcessor.process(
        {
          taskId,
          teamId: context.tenant.teamId,
          datasetId: collection.datasetId,
          collectionId: collection.collectionId,
          mode: 'parse',
          payload: {
            idempotencyKey: input.idempotencyKey,
            policy: input.policy,
          },
        },
        context,
      );
    } catch (error) {
      await this.finishRetrainTask(taskId, 'failed', errorLabel(error), input, context);
      if (error instanceof ApiErrorException && error.error.code === 501071) throw error;
      throw retrainUnavailable(input.collectionId, 'training_processor_failed', context.requestId);
    }
    if (trainingResult.state !== 'success') {
      await this.finishRetrainTask(
        taskId,
        'failed',
        `training_${trainingResult.state}`,
        input,
        context,
      );
      throw retrainUnavailable(
        input.collectionId,
        `training_${trainingResult.state}`,
        context.requestId,
      );
    }

    try {
      await this.deps.collections.update(
        {
          collectionId: collection.collectionId,
          version: collection.version,
          patch: { trainingPolicy: input.policy },
          options: input.options,
        },
        context,
      );
      await this.deps.items.deleteByScope({ ...oldDerived, options: input.options }, context);
      await this.deps.vectors.delete({ ...oldDerived, options: input.options }, context);
      await this.deps.fullText.deleteByCollectionIds(
        { collectionIds: [collection.collectionId], options: input.options },
        context,
      );
      await this.deps.processing.deleteTrainingData(
        { collectionId: collection.collectionId, options: input.options },
        context,
      );
    } catch (error) {
      await this.finishRetrainTask(taskId, 'failed', errorLabel(error), input, context);
      throw retrainUnavailable(input.collectionId, 'retrain_cleanup_failed', context.requestId);
    }
    await this.finishRetrainTask(taskId, 'success', undefined, input, context);
    return { taskId };
  }

  private async finishRetrainTask(
    taskId: string,
    state: 'success' | 'failed',
    errorMsg: string | undefined,
    input: CollectionRetrainInput,
    context: RequestContext,
  ): Promise<void> {
    try {
      await this.deps.processing.finishJob(
        {
          taskId,
          state,
          ...(errorMsg !== undefined ? { errorMsg } : {}),
          options: input.options,
        },
        context,
      );
    } catch {
      // Preserve the original retrain outcome if the task fact cannot be updated.
    }
  }
}

function retrainUnavailable(
  collectionId: string,
  reason: string,
  requestId: string,
): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501069,
      requestId,
      params: { collectionId, reason },
    }),
  );
}

function errorLabel(error: unknown): string {
  if (error instanceof ApiErrorException) return error.error.messageKey;
  return error instanceof Error ? error.name : typeof error;
}
