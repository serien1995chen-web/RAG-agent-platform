import { ApiErrorException, createApiError } from '@kb/contracts';
import { JOB_MODE_TO_QUEUE, buildParseJobId, type QueuePort } from '@kb/dal';
import type {
  DatasetSourceProvider,
  SourceReadResult,
  TaskEnvelope,
  TaskResult,
  TrainingProcessorPort,
} from '../../../ports/capabilities';
import type { CollectionRepository, ProcessingJobRepository } from '../../../ports/repositories';
import type { CollectionSnapshot, PortCallOptions, RequestContext } from '../../../ports/types';

export interface ImportSourceServiceDeps {
  collections: CollectionRepository;
  sourceProvider: DatasetSourceProvider;
  trainingProcessor: TrainingProcessorPort;
  /** 训练任务事实仓储；与 queue 一起用于路径 A 的真实投递。 */
  jobs?: ProcessingJobRepository;
  /** 真实队列投递端；缺失时抛稳定错误，绝不静默返回“已入队”。 */
  queue?: QueuePort;
  /** 空导入判定：返回非空文本才进入 Parse/Chunk/QA 链路（设计 8.3 / BR-WRITE-007）。 */
  resolveRawText?: (read: SourceReadResult, context: RequestContext) => string;
}

export interface CreateFromSourceInput {
  collection: Omit<CollectionSnapshot, 'collectionId' | 'version' | 'createTime' | 'updateTime'>;
  sourceType: string;
  sourceRef: string;
  options: PortCallOptions;
}

export interface CreateFromSourceResult {
  collectionId: string;
  insertLen: number;
  remainingTraining: number;
  status: 'ready';
  taskId?: string;
}

/**
 * 写入路径 A：来源导入（设计文档 9.3 / 8.3）。
 * 预览零正式副作用；正式创建后按「Mongo 事实 → Parse 队列投递」编排。
 * 空文本/纯空白/过滤后无内容：创建 Collection 且 insertLen=0、remainingTraining=0、ready，不创建 Task/Data。
 */
export class ImportSourceService {
  readonly pathKind = 'source-import' as const;
  readonly usesParser = true;
  readonly usesTrainingQueue = true;

  constructor(private readonly deps: ImportSourceServiceDeps) {}

  previewSource(
    input: { datasetId: string; sourceType: string; sourceRef: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<SourceReadResult> {
    return this.deps.sourceProvider.preview(
      {
        datasetId: input.datasetId,
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        options: input.options,
      },
      context,
    );
  }

  /** 预览零副作用：读取来源但不落库；不创建 Collection/Task/Data。 */
  async previewOnly(
    input: { datasetId: string; sourceType: string; sourceRef: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ rawText: string; contentHash: string }> {
    const read = await this.previewSource(input, context);
    return { rawText: this.rawTextOf(read, context), contentHash: read.contentHash };
  }

  async createCollection(
    input: {
      collection: Omit<
        CollectionSnapshot,
        'collectionId' | 'version' | 'createTime' | 'updateTime'
      >;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ collectionId: string }> {
    return this.deps.collections.create(input, context);
  }

  /**
   * 路径 A 编排：读来源 -> 创建 Collection -> 空导入早退（ready, insertLen=0）
   * 或「先写 Mongo 训练任务事实 → 再投递 Parse 队列」。预览与正式创建严格分离。
   */
  async createCollectionFromSource(
    input: CreateFromSourceInput,
    context: RequestContext,
  ): Promise<CreateFromSourceResult> {
    const read = await this.deps.sourceProvider.read(
      {
        datasetId: input.collection.datasetId,
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        options: input.options,
      },
      context,
    );
    const collection = await this.deps.collections.create(
      { collection: input.collection, options: input.options },
      context,
    );
    const rawText = this.rawTextOf(read, context);
    if (rawText.trim().length === 0) {
      // 空导入：无 Task/Data，Collection ready（BR-WRITE-007）。
      return {
        collectionId: collection.collectionId,
        insertLen: 0,
        remainingTraining: 0,
        status: 'ready',
      };
    }

    const version = 1;
    const jobId = buildParseJobId(
      context.tenant.teamId,
      input.collection.datasetId,
      collection.collectionId,
      version,
    );
    const queueName = JOB_MODE_TO_QUEUE.parse;
    if (!this.deps.jobs || !this.deps.queue || !queueName) {
      throw new ApiErrorException(
        createApiError({
          code: 501062,
          requestId: context.requestId,
          params: { dependency: 'queue', mode: 'parse' },
        }),
      );
    }
    // 1) 先写 Mongo 训练任务事实
    await this.deps.jobs.enqueue(
      {
        job: {
          jobId,
          teamId: context.tenant.teamId,
          datasetId: input.collection.datasetId,
          mode: 'parse',
          expireAt: null,
        },
        options: input.options,
      },
      context,
    );
    // 2) 事实成功后再投递队列
    await this.deps.queue.enqueue(queueName, jobId, {
      sourceType: input.sourceType,
      contentHash: read.contentHash,
    });
    return {
      collectionId: collection.collectionId,
      insertLen: 0,
      remainingTraining: 1,
      status: 'ready',
      taskId: jobId,
    };
  }

  processCollection(task: TaskEnvelope, context: RequestContext): Promise<TaskResult> {
    return this.deps.trainingProcessor.process(task, context);
  }

  private rawTextOf(read: SourceReadResult, context: RequestContext): string {
    if (this.deps.resolveRawText) return this.deps.resolveRawText(read, context);
    return read.rawText ?? '';
  }
}
