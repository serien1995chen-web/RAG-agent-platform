import { ApiErrorException, buildIndexVersion, createApiError } from '@kb/contracts';
import type { FullTextStore, VectorController, VectorSearchHit } from '../../../ports/capabilities';
import type { KnowledgeItemRepository } from '../../../ports/repositories';
import type {
  KnowledgeItemSnapshot,
  ObjectRef,
  PortCallOptions,
  RequestContext,
} from '../../../ports/types';
import { buildQaDedupKey, normalizeQaText } from '../domain/dedup-key';

export interface InsertDataServiceDeps {
  items: KnowledgeItemRepository;
  vectors: VectorController;
  fullText: FullTextStore;
  withTransaction?: <T>(work: () => Promise<T>) => Promise<T>;

  emit?: (event: { type: string; dataId: string; teamId: string }) => void;
}

export interface InsertDirectInput {
  dataId: string;
  datasetId: string;
  collectionId: string;
  q: string;
  a?: string;
  indexType?: string;
  chunkIndex?: number;
  indexVersion?: string;
  vector: number[];
  imageId?: string;
  imageRef?: ObjectRef;
  options: PortCallOptions;
}

export interface InsertDirectResult {
  dataId: string;
  inserted: number;
  duplicates: number;
  dedupKey: string;
}

/**
 * 写入路径 B：直接插入（设计文档 9.5）。
 * 顺序固定为「写向量 → Mongo 事务写主数据与全文 → 提交 → 事件」；不经过 Parser 或 Training Queue。
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

  async insertDirect(
    input: InsertDirectInput,
    context: RequestContext,
  ): Promise<InsertDirectResult> {
    const question = normalizeQaText(input.q ?? '');
    if (question.length === 0 && (input.imageId || input.imageRef)) {
      throw new ApiErrorException(
        createApiError({
          code: 501038,
          requestId: context.requestId,
          params: { route: 'insertData' },
        }),
      );
    }
    if (question.length === 0) {
      throw new ApiErrorException(
        createApiError({
          code: 501058,
          requestId: context.requestId,
          params: { missingHeaders: ['q'], duplicateHeaders: [] },
        }),
      );
    }
    const answer = normalizeQaText(input.a ?? '');
    const dedupKey = buildQaDedupKey(question, answer);
    const text = answer.length > 0 ? question + '\n' + answer : question;
    // `qa` 不是 DatasetData.indexes.type 的合法枚举值（会触发 Mongoose 校验 → 501998）。
    // 直接插入的问答数据按设计使用 `question` 索引类型。
    const indexType = input.indexType ?? 'question';
    const indexId = input.dataId + ':' + indexType;
    // 索引版本必须与 Dataset 记录的 indexVersion 同构（model:dimension:schema），
    // 否则向量写入成功但检索侧按版本过滤会 0 命中。
    const indexVersion = input.indexVersion ?? buildIndexVersion('bge-m3', 1536, 'v1');
    const now = new Date().toISOString();
    const item: KnowledgeItemSnapshot = {
      dataId: input.dataId,
      teamId: context.tenant.teamId,
      datasetId: input.datasetId,
      collectionId: input.collectionId,
      q: question,
      a: answer,
      chunkIndex: input.chunkIndex ?? 0,
      indexes: [{ indexId, type: indexType, dataId: input.dataId, text }],
      rebuilding: false,
      version: 1,
      createTime: now,
      updateTime: now,
    };

    await this.deps.vectors.insert(
      {
        records: [
          {
            dataId: input.dataId,
            teamId: context.tenant.teamId,
            datasetId: input.datasetId,
            collectionId: input.collectionId,
            indexId,
            indexVersion,
            vector: input.vector,
          },
        ],
        options: input.options,
      },
      context,
    );

    const run = <T>(work: () => Promise<T>): Promise<T> =>
      this.deps.withTransaction ? this.deps.withTransaction(work) : work();
    const upsert = await run(async () => {
      const result = await this.deps.items.bulkUpsert(
        { items: [item], options: input.options },
        context,
      );
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
      return result;
    });

    this.deps.emit?.({
      type: 'data.inserted',
      dataId: input.dataId,
      teamId: context.tenant.teamId,
    });
    return {
      dataId: input.dataId,
      inserted: upsert.upserted,
      duplicates: upsert.duplicates,
      dedupKey,
    };
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
