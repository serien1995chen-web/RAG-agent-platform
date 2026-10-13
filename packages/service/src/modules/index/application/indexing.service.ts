import { ApiErrorException, createApiError } from '@kb/contracts';
import type { FullTextStore, VectorController, VectorRecord } from '../../../ports/capabilities';
import type { KnowledgeItemRepository } from '../../../ports/repositories';
import type {
  KnowledgeItemIndexValue,
  KnowledgeItemSnapshot,
  PortCallOptions,
  RequestContext,
} from '../../../ports/types';
import { buildVectorId } from '../domain/index-version';

export interface IndexSyncIndexEntry {
  type: string;
  text: string;
  vector: number[];
}

export interface IndexSyncInput {
  item: KnowledgeItemSnapshot;
  indexVersion: string;
  entries: IndexSyncIndexEntry[];
  fullText: string;
  options: PortCallOptions;
}

export interface IndexSyncResult {
  dataId: string;
  version: number;
  written: number;
  deleted: number;
  degraded: string[];
}

export interface IndexingServiceDeps {
  items: KnowledgeItemRepository;
  vectors: VectorController;
  fullText: FullTextStore;
  emit?: (event: { type: string; dataId: string; teamId: string; reason?: string }) => void;
}

export class IndexingService {
  constructor(private readonly deps: IndexingServiceDeps) {}

  async syncItemIndex(input: IndexSyncInput, context: RequestContext): Promise<IndexSyncResult> {
    if (input.item.teamId !== context.tenant.teamId) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId: context.requestId,
          params: { resourceType: 'data', resourceId: input.item.dataId },
        }),
      );
    }

    const records: VectorRecord[] = [];
    const vectorIds: string[] = [];
    const desiredIndexes: KnowledgeItemIndexValue[] = input.entries.map((entry) => {
      const vectorId = buildVectorId(input.item.dataId, entry.type, input.indexVersion);
      vectorIds.push(vectorId);
      records.push({
        teamId: context.tenant.teamId,
        datasetId: input.item.datasetId,
        collectionId: input.item.collectionId,
        dataId: vectorId,
        indexId: `${input.item.dataId}:${entry.type}`,
        indexVersion: input.indexVersion,
        vector: entry.vector,
      });
      return {
        indexId: `${input.item.dataId}:${entry.type}`,
        type: entry.type,
        dataId: vectorId,
        text: entry.text,
      };
    });

    if (records.length > 0) {
      await this.deps.vectors.insert({ records, options: input.options }, context);
    }

    const updated = await this.deps.items.updateIndexes(
      {
        dataId: input.item.dataId,
        version: input.item.version,
        indexes: desiredIndexes,
        options: input.options,
      },
      context,
    );

    await this.deps.fullText.write(
      {
        datasetId: input.item.datasetId,
        collectionId: input.item.collectionId,
        dataId: input.item.dataId,
        text: input.fullText,
        options: input.options,
      },
      context,
    );

    const staleIds = input.item.indexes
      .map((index) => index.dataId)
      .filter((id): id is string => Boolean(id) && !vectorIds.includes(id));
    const degraded: string[] = [];
    let deleted = 0;

    if (staleIds.length > 0) {
      try {
        const result = await this.deps.vectors.delete(
          {
            dataIds: staleIds,
            datasetId: input.item.datasetId,
            collectionId: input.item.collectionId,
            options: input.options,
          },
          context,
        );
        deleted = result.deleted;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        degraded.push(reason);
        this.deps.emit?.({
          type: 'index.cleanup_failed',
          dataId: input.item.dataId,
          teamId: context.tenant.teamId,
          reason,
        });
      }
    }

    this.deps.emit?.({
      type: 'index.synced',
      dataId: input.item.dataId,
      teamId: context.tenant.teamId,
    });

    return {
      dataId: input.item.dataId,
      version: updated.version,
      written: records.length,
      deleted,
      degraded,
    };
  }
}
