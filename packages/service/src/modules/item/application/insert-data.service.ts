import type { FullTextStore, VectorController, VectorSearchHit } from '../../../ports/capabilities';
import type { KnowledgeItemRepository } from '../../../ports/repositories';
import type { KnowledgeItemSnapshot, PortCallOptions, RequestContext } from '../../../ports/types';

export interface InsertDataServiceDeps {
  items: KnowledgeItemRepository;
  vectors: VectorController;
  fullText: FullTextStore;
}

/**
 * 写入路径 B：直接插入（设计文档 1.5 / 8.2）。
 * insertData -> 权限、容量与重复校验 -> 规范化索引 -> 写向量 -> 写 Mongo 主数据与全文 -> 返回。
 * 该路径不经过 Parser，也不经过 Training Queue。
 */
export class InsertDataService {
  readonly pathKind = 'direct-insert' as const;
  readonly usesParser = false;
  readonly usesTrainingQueue = false;

  constructor(private readonly deps: InsertDataServiceDeps) {}

  insertItem(
    input: { item: KnowledgeItemSnapshot; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ upserted: number; duplicates: number }> {
    return this.deps.items.bulkUpsert({ items: [input.item], options: input.options }, context);
  }

  writeProjection(
    input: {
      datasetId: string;
      collectionId: string;
      dataId: string;
      text: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<void> {
    return this.deps.fullText.write(input, context);
  }

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
    return this.deps.vectors.embRecall(input, context);
  }
}
