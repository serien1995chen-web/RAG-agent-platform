import { ApiErrorException, createApiError } from '@kb/contracts';
import { Types, type Connection, type FilterQuery } from 'mongoose';
import type { FullTextHit, FullTextStore } from '../../../ports/capabilities';
import type { PortCallOptions, RequestContext } from '../../../ports/types';
import { validateTenantContext } from '../../../ports/types';
import { FullTextRepository, tokenizeForSearch } from '../../../shared/persistence/full-text';
import {
  registerMongoModels,
  type DatasetDataTextDoc,
  type RegisteredModels,
} from '../../../shared/persistence/schemas';

/**
 * FullTextStore Adapter（P2-05，PORT-STORE-001）：
 * Mongo $text + jieba 搜索模式分词；所有查询强制团队谓词，跨团队零命中。
 * 装配入口（modules/index/adapter/index.ts）由 P2-17 负责，本文件不修改 barrel。
 */
export class FullTextStoreAdapter implements FullTextStore {
  private readonly models: RegisteredModels;
  private readonly repository: FullTextRepository;

  constructor(connection: Connection) {
    this.models = registerMongoModels(connection);
    this.repository = new FullTextRepository(connection);
  }

  private requireTeam(context: RequestContext): string {
    const result = validateTenantContext(context.tenant, context.requestId);
    if (!result.ok) throw new ApiErrorException(result.error);
    return context.tenant.teamId;
  }

  private missing(context: RequestContext, fields: string[]): ApiErrorException {
    return new ApiErrorException(
      createApiError({
        code: 501012,
        requestId: context.requestId,
        params: { missing: fields },
      }),
    );
  }

  private async run<T>(
    operation: string,
    context: RequestContext,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ApiErrorException) throw error;
      throw new ApiErrorException(
        createApiError({
          code: 501016,
          requestId: context.requestId,
          params: { store: 'mongo', operation },
        }),
      );
    }
  }

  search(
    input: {
      datasetId: string;
      collectionIds?: string[];
      text: string;
      limit: number;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<FullTextHit[]> {
    return this.run('full_text.search', context, async () => {
      const teamId = this.requireTeam(context);
      if (!input.datasetId) throw this.missing(context, ['datasetId']);

      const token = tokenizeForSearch(input.text);
      if (token.length === 0) return [];

      const match: FilterQuery<DatasetDataTextDoc> = {
        teamId: new Types.ObjectId(teamId),
        datasetId: new Types.ObjectId(input.datasetId),
        $text: { $search: token },
      };
      if (input.collectionIds !== undefined && input.collectionIds.length > 0) {
        match.collectionId = { $in: input.collectionIds.map((id) => new Types.ObjectId(id)) };
      }

      const rows = await this.models.DatasetDataText.aggregate<{
        dataId: Types.ObjectId;
        collectionId: Types.ObjectId;
        score: number;
      }>([
        { $match: match },
        { $addFields: { score: { $meta: 'textScore' } } },
        { $sort: { score: -1 } },
        { $limit: input.limit },
      ]);

      return rows.map((row) => ({
        dataId: String(row.dataId),
        collectionId: String(row.collectionId),
        score: Number(row.score),
      }));
    });
  }

  write(
    input: {
      datasetId: string;
      collectionId: string;
      dataId: string;
      text: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<void> {
    return this.run('full_text.write', context, async () => {
      this.requireTeam(context);
      if (!input.datasetId) throw this.missing(context, ['datasetId']);
      if (!input.collectionId) throw this.missing(context, ['collectionId']);
      if (!input.dataId) throw this.missing(context, ['dataId']);
      await this.repository.write(
        [
          {
            datasetId: input.datasetId,
            collectionId: input.collectionId,
            dataId: input.dataId,
            text: input.text,
          },
        ],
        context,
      );
    });
  }

  deleteByDataId(
    input: { dataId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ deleted: number }> {
    return this.run('full_text.delete_by_data_id', context, async () => {
      this.requireTeam(context);
      if (!input.dataId) throw this.missing(context, ['dataId']);
      return { deleted: await this.repository.deleteByDataId(input.dataId, context) };
    });
  }

  deleteByDatasetIds(
    input: { datasetIds: string[]; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ deleted: number }> {
    return this.run('full_text.delete_by_dataset_ids', context, async () => {
      this.requireTeam(context);
      return { deleted: await this.repository.deleteByDatasetIds(input.datasetIds, context) };
    });
  }

  deleteByCollectionIds(
    input: { collectionIds: string[]; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ deleted: number }> {
    return this.run('full_text.delete_by_collection_ids', context, async () => {
      this.requireTeam(context);
      return { deleted: await this.repository.deleteByCollectionIds(input.collectionIds, context) };
    });
  }
}

export function createFullTextStoreAdapter(connection: Connection): FullTextStore {
  return new FullTextStoreAdapter(connection);
}
