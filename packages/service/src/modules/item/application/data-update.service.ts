import type { FullTextStore, VectorController } from '../../../ports/capabilities';
import type { KnowledgeItemRepository } from '../../../ports/repositories';
import type { KnowledgeItemSnapshot, PortCallOptions, RequestContext } from '../../../ports/types';
import type { ModelRuntimeAdapter } from './model-runtime.adapter';

export interface DataUpdateServiceDeps {
  items: KnowledgeItemRepository;
  vectors: VectorController;
  fullText: FullTextStore;
  modelRuntime: ModelRuntimeAdapter;
}

export interface DataUpdateInput {
  dataId: string;
  datasetId: string;
  collectionId: string;
  version: number;
  q?: string;
  a?: string;
  indexes?: Array<{ indexId: string; text: string; version: number }>;
  existing: Pick<KnowledgeItemSnapshot, 'q' | 'a' | 'indexes'>;
  options: PortCallOptions;
}

/**
 * P4-09 Data 更新（Rev2 内部应用服务）：顺序固定为
 * 新向量 → Mongo CAS 切换 q/a/indexes → FullText → （旧向量清理尽力而为）。
 * 旧向量清理受 VectorController.delete 无 indexVersion 维度限制，仅写新版本引用。
 */
export class DataUpdateService {
  constructor(private readonly deps: DataUpdateServiceDeps) {}

  async updateItem(
    input: DataUpdateInput,
    context: RequestContext,
  ): Promise<{ dataId: string; version: number }> {
    const q = input.q ?? input.existing.q ?? '';
    const a = input.a ?? input.existing.a ?? '';
    const text = a.length > 0 ? `${q}\n${a}` : q;
    const nextVersion = input.version + 1;
    const indexes =
      input.indexes && input.indexes.length > 0
        ? input.indexes.map((patch) => {
            const previous = input.existing.indexes.find(
              (index) => index.indexId === patch.indexId,
            );
            return {
              indexId: patch.indexId,
              type: previous?.type ?? 'default',
              dataId: input.dataId,
              text: patch.text,
            };
          })
        : input.existing.indexes.map((index) =>
            index.type === 'default' || index.type === 'question' ? { ...index, text } : index,
          );
    // 1) 先写新向量
    const vector = await this.deps.modelRuntime.embedText(
      { text, options: input.options },
      context,
    );
    await this.deps.vectors.insert(
      {
        records: [
          {
            dataId: input.dataId,
            teamId: context.tenant.teamId,
            datasetId: input.datasetId,
            collectionId: input.collectionId,
            indexId: `${input.dataId}:default`,
            indexVersion: String(nextVersion),
            vector,
          },
        ],
        options: input.options,
      },
      context,
    );
    // 2) Mongo CAS 切换：先用 updateIndexes 以版本做条件更新（陈旧版本 501067），
    //    只有 CAS 成功者才继续写 q/a，避免并发覆盖。
    const cas = await this.deps.items.updateIndexes(
      { dataId: input.dataId, version: input.version, indexes, options: input.options },
      context,
    );
    const now = new Date().toISOString();
    await this.deps.items.bulkUpsert(
      {
        items: [
          {
            dataId: input.dataId,
            teamId: context.tenant.teamId,
            datasetId: input.datasetId,
            collectionId: input.collectionId,
            q,
            a,
            indexes,
            rebuilding: false,
            version: cas.version,
            createTime: now,
            updateTime: now,
          },
        ],
        options: input.options,
      },
      context,
    );
    // 3) FullText 写
    await this.deps.fullText.write(
      {
        datasetId: input.datasetId,
        collectionId: input.collectionId,
        dataId: input.dataId,
        text,
        options: input.options,
      },
      context,
    );
    return { dataId: input.dataId, version: cas.version };
  }
}
