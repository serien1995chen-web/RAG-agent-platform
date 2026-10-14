import {
  ApiErrorException,
  buildIndexVersion,
  createApiError,
  type ModelReference,
} from '@kb/contracts';
import { buildVectorJobId } from '@kb/dal';
import type { FullTextStore, VectorController, VectorRecord } from '../../../ports/capabilities';
import type {
  CollectionRepository,
  KnowledgeBaseRepository,
  KnowledgeItemRepository,
} from '../../../ports/repositories';
import type {
  KnowledgeItemIndexValue,
  KnowledgeItemSnapshot,
  PortCallOptions,
  RequestContext,
} from '../../../ports/types';
import type { KnowledgeBaseQueryRepository } from '../domain/dataset-query';

const PAGE_SIZE = 100;
const EMBEDDING_DIMENSION = 1536;
const INDEX_SCHEMA_VERSION = 'v1';

type RebuildKnowledgeBase = KnowledgeBaseRepository & KnowledgeBaseQueryRepository;

interface RebuildEmbeddingRuntime {
  embed(
    input: {
      models: { embeddingModel: string };
      texts: string[];
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<number[][]>;
}

interface RebuildIndexVersionSwitchRuntime {
  switchIndexVersion(
    input: {
      datasetId: string;
      expectedVersion: number;
      expectedIndexVersion: string;
      nextIndexVersion: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ version: number }>;
}

interface RebuildProcessingRuntime {
  getQueueStats(
    input: { datasetId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<Array<{ mode: string; depth: number; running: number }>>;
  enqueueJob(
    input: {
      job: {
        jobId: string;
        teamId: string;
        datasetId: string;
        mode: string;
        expireAt: null;
      };
      budgetKind: 'rebuild';
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

interface RebuildItemRepository extends KnowledgeItemRepository {
  list(
    input: {
      collectionId: string;
      page: number;
      limit: number;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ total: number; list: KnowledgeItemSnapshot[]; cursor: string | null }>;
  get(
    input: { dataId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<KnowledgeItemSnapshot>;
}

interface RebuildEmbeddingServiceDeps {
  knowledgeBase: RebuildKnowledgeBase;
  collections: CollectionRepository;
  items: RebuildItemRepository;
  processing: RebuildProcessingRuntime;
  embedding: RebuildEmbeddingRuntime;
  vectors: VectorController;
  fullText: FullTextStore;
  indexVersionSwitch: RebuildIndexVersionSwitchRuntime;
}

export interface RebuildEmbeddingInput {
  datasetId: string;
  modelRef: ModelReference;
  options: PortCallOptions;
}

export interface RebuildEmbeddingResult {
  taskId: string;
  state: 'completed' | 'cleanup_pending';
}

interface PreparedRebuildItem {
  item: KnowledgeItemSnapshot;
  indexes: KnowledgeItemIndexValue[];
  oldVectorIds: string[];
  vectorRecords: VectorRecord[];
  fullText: string;
}

export class RebuildEmbeddingService {
  constructor(private readonly deps: RebuildEmbeddingServiceDeps) {}

  async requestRebuild(
    input: RebuildEmbeddingInput,
    context: RequestContext,
  ): Promise<RebuildEmbeddingResult> {
    this.validateModel(input.modelRef, context);
    const dataset = await this.deps.knowledgeBase.findByDatasetId(
      { datasetId: input.datasetId },
      context,
    );
    if (!dataset) {
      throw rebuildNotFound(input.datasetId, context.requestId);
    }
    if (dataset.vectorModel === input.modelRef.model) {
      throw invalidModel(input.modelRef.model, context.requestId, 'different');
    }

    const queueStats = await this.deps.processing.getQueueStats(
      { datasetId: input.datasetId, options: input.options },
      context,
    );
    if (queueStats.some((stats) => stats.depth > 0 || stats.running > 0)) {
      throw rebuildConflict(input.datasetId, context.requestId);
    }

    const items = await this.listDatasetItems(input.datasetId, input.options, context);
    if (items.some((item) => item.rebuilding)) {
      throw rebuildConflict(input.datasetId, context.requestId);
    }

    const updated = await this.deps.knowledgeBase.update(
      {
        datasetId: input.datasetId,
        version: dataset.version,
        patch: { vectorModel: input.modelRef.model },
        options: input.options,
      },
      context,
    );
    for (const item of items) {
      await this.deps.items.bulkUpsert(
        { items: [{ ...item, rebuilding: true }], options: input.options },
        context,
      );
    }

    const nextIndexVersion = buildIndexVersion(
      input.modelRef.model,
      input.modelRef.dimension,
      INDEX_SCHEMA_VERSION,
    );
    const taskId = buildVectorJobId(context.tenant.teamId, input.datasetId, nextIndexVersion);
    await this.deps.processing.enqueueJob(
      {
        job: {
          jobId: taskId,
          teamId: context.tenant.teamId,
          datasetId: input.datasetId,
          mode: 'vector',
          expireAt: null,
        },
        budgetKind: 'rebuild',
        options: input.options,
      },
      context,
    );

    const prepared: PreparedRebuildItem[] = [];
    for (const item of items) {
      const current = await this.deps.items.get(
        { dataId: item.dataId, options: input.options },
        context,
      );
      const sourceEntries = this.sourceEntries(current);
      let vectors: number[][] = [];
      if (sourceEntries.length > 0) {
        vectors = await this.deps.embedding.embed(
          {
            models: { embeddingModel: input.modelRef.model },
            texts: sourceEntries.map((entry) => entry.text),
            options: input.options,
          },
          context,
        );
      }
      const vectorRecords: VectorRecord[] = [];
      const indexes: KnowledgeItemIndexValue[] = sourceEntries.map((entry, index) => {
        const vectorId = `${current.dataId}:${entry.type}:${nextIndexVersion}`;
        vectorRecords.push({
          teamId: context.tenant.teamId,
          datasetId: current.datasetId,
          collectionId: current.collectionId,
          dataId: vectorId,
          indexId: `${current.dataId}:${entry.type}`,
          indexVersion: nextIndexVersion,
          vector: vectors[index] ?? [],
        });
        return {
          indexId: `${current.dataId}:${entry.type}`,
          type: entry.type,
          dataId: vectorId,
          text: entry.text,
        };
      });
      prepared.push({
        item: current,
        indexes,
        oldVectorIds: current.indexes
          .map((index) => index.dataId)
          .filter((dataId): dataId is string => Boolean(dataId)),
        vectorRecords,
        fullText: sourceEntries.map((entry) => entry.text).join('\n'),
      });
    }

    const allVectorRecords = prepared.flatMap((entry) => entry.vectorRecords);
    if (allVectorRecords.length > 0) {
      await this.deps.vectors.insert(
        { records: allVectorRecords, options: input.options },
        context,
      );
    }

    try {
      await this.deps.indexVersionSwitch.switchIndexVersion(
        {
          datasetId: input.datasetId,
          expectedVersion: updated.version,
          expectedIndexVersion: dataset.indexVersion,
          nextIndexVersion,
          options: input.options,
        },
        context,
      );
    } catch {
      await this.finishRebuildTask(taskId, 'failed', 'cas_failed', input, context);
      throw rebuildConflict(input.datasetId, context.requestId);
    }

    let cleanupPending = false;
    for (const entry of prepared) {
      try {
        await this.deps.items.updateIndexes(
          {
            dataId: entry.item.dataId,
            version: entry.item.version,
            indexes: entry.indexes,
            options: input.options,
          },
          context,
        );
        await this.deps.fullText.write(
          {
            datasetId: entry.item.datasetId,
            collectionId: entry.item.collectionId,
            dataId: entry.item.dataId,
            text: entry.fullText,
            options: input.options,
          },
          context,
        );
        if (entry.oldVectorIds.length > 0) {
          await this.deps.vectors.delete(
            {
              dataIds: entry.oldVectorIds,
              datasetId: entry.item.datasetId,
              collectionId: entry.item.collectionId,
              options: input.options,
            },
            context,
          );
        }
        const refreshed = await this.deps.items.get(
          { dataId: entry.item.dataId, options: input.options },
          context,
        );
        await this.deps.items.bulkUpsert(
          { items: [{ ...refreshed, rebuilding: false }], options: input.options },
          context,
        );
      } catch (error) {
        cleanupPending = true;
        await this.finishRebuildTask(
          taskId,
          'failed',
          `cleanup_pending:${errorLabel(error)}`,
          input,
          context,
        );
        break;
      }
    }
    if (cleanupPending) return { taskId, state: 'cleanup_pending' };
    await this.finishRebuildTask(taskId, 'success', undefined, input, context);
    return { taskId, state: 'completed' };
  }

  private async finishRebuildTask(
    taskId: string,
    state: 'success' | 'failed',
    errorMsg: string | undefined,
    input: RebuildEmbeddingInput,
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
      // Finish facts are best-effort; cleanup state must not hide the switched indexVersion.
    }
  }

  private validateModel(modelRef: ModelReference, context: RequestContext): void {
    if (!modelRef.model.trim()) {
      throw invalidModel(modelRef.model, context.requestId, 'non-empty');
    }
    if (modelRef.dimension !== EMBEDDING_DIMENSION) {
      throw new ApiErrorException(
        createApiError({
          code: 501013,
          requestId: context.requestId,
          params: { expected: EMBEDDING_DIMENSION, actual: modelRef.dimension },
        }),
      );
    }
  }

  private async listDatasetItems(
    datasetId: string,
    options: PortCallOptions,
    context: RequestContext,
  ): Promise<KnowledgeItemSnapshot[]> {
    const items: KnowledgeItemSnapshot[] = [];
    let collectionPage = 1;
    while (true) {
      const collections = await this.deps.collections.list(
        { datasetId, page: collectionPage, limit: PAGE_SIZE, options },
        context,
      );
      for (const collection of collections.list) {
        let itemPage = 1;
        while (true) {
          const page = await this.deps.items.list(
            {
              collectionId: collection.collectionId,
              page: itemPage,
              limit: PAGE_SIZE,
              options,
            },
            context,
          );
          items.push(...page.list);
          if (page.list.length === 0 || itemPage * PAGE_SIZE >= page.total) break;
          itemPage += 1;
        }
      }
      if (collections.list.length === 0 || collectionPage * PAGE_SIZE >= collections.total) break;
      collectionPage += 1;
    }
    return items;
  }

  private sourceEntries(item: KnowledgeItemSnapshot): Array<{ type: string; text: string }> {
    const indexed = item.indexes
      .filter((index) => index.text.trim().length > 0)
      .map((index) => ({ type: index.type, text: index.text }));
    if (indexed.length > 0) return indexed;

    const text = item.q?.trim() || item.a?.trim() || '';
    return text ? [{ type: 'default', text }] : [];
  }
}

function invalidModel(value: string, requestId: string, rangeOrVersion: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501013,
      requestId,
      params: { field: 'modelRef.model', value, rangeOrVersion },
    }),
  );
}

function rebuildConflict(datasetId: string, requestId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501069,
      requestId,
      params: { datasetId },
    }),
  );
}

function rebuildNotFound(datasetId: string, requestId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501013,
      requestId,
      params: { datasetId, reason: 'not_found' },
    }),
  );
}

function errorLabel(error: unknown): string {
  if (error instanceof ApiErrorException) return error.error.messageKey;
  return error instanceof Error ? error.name : typeof error;
}
