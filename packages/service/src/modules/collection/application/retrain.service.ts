import { ApiErrorException, createApiError } from '@kb/contracts';
import { buildParseJobId } from '@kb/dal';
import type {
  FullTextStore,
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

    const collection = await this.deps.collections.get(
      { collectionId: input.collectionId, options: input.options },
      context,
    );
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

    await this.deps.items.deleteByScope(
      {
        datasetId: collection.datasetId,
        collectionId: collection.collectionId,
        options: input.options,
      },
      context,
    );
    await this.deps.vectors.delete(
      {
        datasetId: collection.datasetId,
        collectionId: collection.collectionId,
        options: input.options,
      },
      context,
    );
    await this.deps.fullText.deleteByCollectionIds(
      { collectionIds: [collection.collectionId], options: input.options },
      context,
    );
    await this.deps.processing.deleteTrainingData(
      { collectionId: collection.collectionId, options: input.options },
      context,
    );

    const updated = await this.deps.collections.update(
      {
        collectionId: collection.collectionId,
        version: collection.version,
        patch: { trainingPolicy: input.policy },
        options: input.options,
      },
      context,
    );
    const taskId = buildParseJobId(
      context.tenant.teamId,
      collection.datasetId,
      collection.collectionId,
      updated.version,
    );
    await this.deps.trainingProcessor.process(
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
    return { taskId };
  }
}
