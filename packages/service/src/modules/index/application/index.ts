import { ApiErrorException, createApiError } from '@kb/contracts';
import type { RequestContext } from '../../../ports/types';
import type { VectorController } from '../../../ports/capabilities';
import type { PortCallOptions } from '../../../ports/types';
import type { KnowledgeItemSnapshot } from '../../../ports/types';
import type { VectorSearchHit } from '../../../ports/capabilities';

export {
  EMBEDDING_DIMENSION,
  EmbeddingService,
  createUnimplementedEmbeddingGateway,
} from './embedding.service';
export type { EmbeddingGateway, EmbeddingRequest, EmbeddingServiceDeps } from './embedding.service';
export { IndexingService } from './indexing.service';
export type {
  IndexSyncIndexEntry,
  IndexSyncInput,
  IndexSyncResult,
  IndexingServiceDeps,
} from './indexing.service';
export { IndexVersionSwitchService } from './index-version-switch';
export type { DatasetIndexVersionStore } from './index-version-switch';
export { CitationService } from './citation.service';
export type { CitationServiceDeps, ResolvedCitationInput } from './citation.service';

/** 仅客户端可维护的索引类型；其余（default/imageEmbedding/summary/question/image）为系统索引。 */
export const CLIENT_WRITABLE_INDEX_TYPE = 'custom' as const;

const INDEX_OPTIONS: PortCallOptions = { timeoutMs: 5_000 };

/** 索引管理编排所需的知识条目读写能力（teamId 谓词由仓储层强制）。 */
export interface IndexItemRepository {
  get?(
    input: { dataId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<KnowledgeItemSnapshot | null>;
  updateIndexes(
    input: {
      dataId: string;
      version: number;
      indexes: KnowledgeItemSnapshot['indexes'];
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ version: number }>;
}

export interface IndexServiceDeps {
  repository: VectorController;
  items?: IndexItemRepository;
}

/** KnowledgeItemIndex 应用编排骨架：只依赖 Port，不直接拼装存储查询。 */
export class IndexApplicationService {
  constructor(private readonly deps: IndexServiceDeps) {}

  recallVectors(
    input: {
      teamId: string;
      datasetId: string;
      collectionId?: string;
      vector: number[];
      limit: number;
      indexVersion?: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<VectorSearchHit[]> {
    return this.deps.repository.embRecall(input, context);
  }

  private indexError(
    context: RequestContext,
    code: number,
    params: Record<string, unknown>,
  ): ApiErrorException {
    return new ApiErrorException(createApiError({ code, requestId: context.requestId, params }));
  }

  private async loadItem(dataId: string, context: RequestContext): Promise<KnowledgeItemSnapshot> {
    const items = this.deps.items;
    if (!items?.get) {
      throw this.indexError(context, 501062, { dependency: 'index_item_repository' });
    }
    const item = await items.get({ dataId, options: INDEX_OPTIONS }, context);
    if (!item || item.teamId !== context.tenant.teamId) {
      throw this.indexError(context, 501070, { resourceType: 'data', resourceId: dataId });
    }
    return item;
  }

  private requireItems(context: RequestContext): IndexItemRepository {
    const items = this.deps.items;
    if (!items || !items.get) {
      throw this.indexError(context, 501062, { dependency: 'index_item_repository' });
    }
    return items;
  }

  async createIndex(
    input: { dataId: string; type: string; text: string },
    context: RequestContext,
  ): Promise<{ indexId: string }> {
    if (input.type !== CLIENT_WRITABLE_INDEX_TYPE) {
      throw this.indexError(context, 501041, { type: input.type });
    }
    const item = await this.loadItem(input.dataId, context);
    const items = this.requireItems(context);
    const indexId = `${input.dataId}:${input.type}`;
    const entry: KnowledgeItemSnapshot['indexes'][number] = {
      indexId,
      type: input.type,
      dataId: indexId,
      text: input.text,
    };
    const indexes = [...item.indexes.filter((existing) => existing.indexId !== indexId), entry];
    await items.updateIndexes(
      { dataId: item.dataId, version: item.version, indexes, options: INDEX_OPTIONS },
      context,
    );
    return { indexId };
  }

  async updateIndex(
    input: { dataId: string; indexId: string; text: string; version: number },
    context: RequestContext,
  ): Promise<{ indexId: string; version: number }> {
    const item = await this.loadItem(input.dataId, context);
    const items = this.requireItems(context);
    const target = item.indexes.find((existing) => existing.indexId === input.indexId);
    if (!target) {
      throw this.indexError(context, 501070, {
        resourceType: 'index',
        resourceId: input.indexId,
      });
    }
    if (target.type !== CLIENT_WRITABLE_INDEX_TYPE) {
      throw this.indexError(context, 501042, { indexId: input.indexId, dataId: input.dataId });
    }
    const indexes = item.indexes.map((existing) =>
      existing.indexId === input.indexId ? { ...existing, text: input.text } : existing,
    );
    const updated = await items.updateIndexes(
      { dataId: item.dataId, version: input.version, indexes, options: INDEX_OPTIONS },
      context,
    );
    return { indexId: input.indexId, version: updated.version };
  }

  async deleteIndex(
    input: { dataId: string; indexId: string },
    context: RequestContext,
  ): Promise<{ indexId: string; state: 'deleted' }> {
    const item = await this.loadItem(input.dataId, context);
    const items = this.requireItems(context);
    const target = item.indexes.find((existing) => existing.indexId === input.indexId);
    if (!target) {
      throw this.indexError(context, 501070, {
        resourceType: 'index',
        resourceId: input.indexId,
      });
    }
    if (target.type !== CLIENT_WRITABLE_INDEX_TYPE) {
      throw this.indexError(context, 501042, { indexId: input.indexId, dataId: input.dataId });
    }
    const indexes = item.indexes.filter((existing) => existing.indexId !== input.indexId);
    await items.updateIndexes(
      { dataId: item.dataId, version: item.version, indexes, options: INDEX_OPTIONS },
      context,
    );
    return { indexId: input.indexId, state: 'deleted' };
  }
}
