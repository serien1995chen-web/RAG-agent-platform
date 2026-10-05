import type {
  DatasetSourceProvider,
  SourceReadResult,
  TaskEnvelope,
  TaskResult,
  TrainingProcessorPort,
} from '../../../ports/capabilities';
import type { CollectionRepository } from '../../../ports/repositories';
import type { CollectionSnapshot, PortCallOptions, RequestContext } from '../../../ports/types';

export interface ImportSourceServiceDeps {
  collections: CollectionRepository;
  sourceProvider: DatasetSourceProvider;
  trainingProcessor: TrainingProcessorPort;
}

/**
 * 写入路径 A：来源导入（设计文档 1.5 / 8.2）。
 * 上传或选择来源 -> 可选预览 -> 创建 Collection -> Parse -> Chunk 或 QA -> Embedding -> 索引与 Data。
 * 预览阶段不得创建 Collection；正式创建后统一投递训练任务。
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

  createCollection(
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

  processCollection(task: TaskEnvelope, context: RequestContext): Promise<TaskResult> {
    return this.deps.trainingProcessor.process(task, context);
  }
}
