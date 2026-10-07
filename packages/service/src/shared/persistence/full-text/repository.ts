import { Types, type ClientSession, type Connection, type FilterQuery } from 'mongoose';
import type { RequestContext } from '../../../ports/types';
import { registerMongoModels, type DatasetDataTextDoc, type RegisteredModels } from '../schemas';
import { tenantScopedModel } from '../tenant-scoped-model';
import { tokenizeForSearch } from './tokenizer';

/** 全文投影批量写入大小（设计文档 7.6 PORT-STORE-001：batch 50）。 */
export const FULL_TEXT_BATCH_SIZE = 50;

export interface FullTextProjectionInput {
  datasetId: string;
  collectionId: string;
  dataId: string;
  text: string;
}

/**
 * 全文投影仓储（设计文档 10.6）：
 * 按 teamId+datasetId+collectionId+dataId upsert；批量 50、ordered=false；
 * 查询与删除全部强制团队谓词。
 */
export class FullTextRepository {
  private readonly models: RegisteredModels;

  constructor(connection: Connection) {
    this.models = registerMongoModels(connection);
  }

  async write(
    items: readonly FullTextProjectionInput[],
    context: RequestContext,
    session?: ClientSession,
  ): Promise<void> {
    if (items.length === 0) return;
    const scoped = tenantScopedModel(this.models.DatasetDataText, context);
    const now = new Date();

    for (let offset = 0; offset < items.length; offset += FULL_TEXT_BATCH_SIZE) {
      const chunk = items.slice(offset, offset + FULL_TEXT_BATCH_SIZE);
      const operations = chunk.map((item) => ({
        updateOne: {
          filter: scoped.filter({
            datasetId: new Types.ObjectId(item.datasetId),
            collectionId: new Types.ObjectId(item.collectionId),
            dataId: new Types.ObjectId(item.dataId),
          }) as FilterQuery<DatasetDataTextDoc>,
          update: {
            $set: { fullTextToken: tokenizeForSearch(item.text), updateTime: now },
            $setOnInsert: { createTime: now },
          },
          upsert: true,
        },
      }));

      await this.models.DatasetDataText.bulkWrite(operations, {
        ordered: false,
        ...(session !== undefined ? { session } : {}),
      });
    }
  }

  async deleteByDataId(
    dataId: string,
    context: RequestContext,
    session?: ClientSession,
  ): Promise<number> {
    const scoped = tenantScopedModel(this.models.DatasetDataText, context);
    const result = await this.models.DatasetDataText.deleteMany(
      scoped.filter({ dataId: new Types.ObjectId(dataId) }) as FilterQuery<DatasetDataTextDoc>,
      { ...(session !== undefined ? { session } : {}) },
    );
    return result.deletedCount ?? 0;
  }

  async deleteByDatasetIds(
    datasetIds: readonly string[],
    context: RequestContext,
    session?: ClientSession,
  ): Promise<number> {
    if (datasetIds.length === 0) return 0;
    const scoped = tenantScopedModel(this.models.DatasetDataText, context);
    const result = await this.models.DatasetDataText.deleteMany(
      scoped.filter({
        datasetId: { $in: datasetIds.map((id) => new Types.ObjectId(id)) },
      }) as FilterQuery<DatasetDataTextDoc>,
      { ...(session !== undefined ? { session } : {}) },
    );
    return result.deletedCount ?? 0;
  }

  async deleteByCollectionIds(
    collectionIds: readonly string[],
    context: RequestContext,
    session?: ClientSession,
  ): Promise<number> {
    if (collectionIds.length === 0) return 0;
    const scoped = tenantScopedModel(this.models.DatasetDataText, context);
    const result = await this.models.DatasetDataText.deleteMany(
      scoped.filter({
        collectionId: { $in: collectionIds.map((id) => new Types.ObjectId(id)) },
      }) as FilterQuery<DatasetDataTextDoc>,
      { ...(session !== undefined ? { session } : {}) },
    );
    return result.deletedCount ?? 0;
  }
}
