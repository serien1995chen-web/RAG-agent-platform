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
    // 2) Mongo 原子 CAS：q/a/indexes/updateTime 同一次条件更新完成，陈旧版本 501067。
    const cas = await this.deps.items.casUpdateItem(
      {
        dataId: input.dataId,
        datasetId: input.datasetId,
        collectionId: input.collectionId,
        version: input.version,
        q,
        a,
        ...(input.existing.q !== undefined ? { previousQ: input.existing.q } : {}),
        ...(input.existing.a !== undefined ? { previousA: input.existing.a } : {}),
        indexes,
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
