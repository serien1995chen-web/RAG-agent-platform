import { createHash } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';
import { chunkText } from '@kb/chunk';
import { DEFAULT_CHUNK_POLICY, type ChunkPolicy } from '@kb/chunk';
import type {
  DatasetSourceProvider,
  TaskEnvelope,
  TaskResult,
  TrainingCollectionPort,
  TrainingDatasetPort,
  TrainingEmbeddingPort,
  TrainingInsertPort,
  TrainingProcessorPort,
} from '../../../ports/capabilities';
import type { RequestContext } from '../../../ports/types';

export interface TrainingProcessorDeps {
  collections: TrainingCollectionPort;
  datasets: TrainingDatasetPort;
  sourceProvider: DatasetSourceProvider;
  embedding: TrainingEmbeddingPort;
  inserts: TrainingInsertPort;
}

/**
 * 训练链最小闭环：parse → chunk → embed → 写 Data/向量/全文；qa 模式处理 pushData。
 *
 * 设计 12.10 的 parse/chunk/qa/vector 四段队列在首期以单段 parse 完成
 * （同一任务内同步完成切分与向量化）。
 * 状态推进：running → ready（成功）/ error（失败），失败原因交由 Worker 记录。
 */
export function createTrainingProcessor(deps: TrainingProcessorDeps): TrainingProcessorPort {
  return {
    async process(task: TaskEnvelope, context: RequestContext): Promise<TaskResult> {
      if (task.mode === 'qa') {
        return processQa(deps, task, context);
      }
      if (task.mode !== 'parse') {
        return { state: 'failed', errorMsg: `unsupported_training_mode:${task.mode}` };
      }
      const collectionId = task.collectionId;
      const datasetId = task.datasetId;
      if (!collectionId || !datasetId) {
        return { state: 'failed', errorMsg: 'missing_collection_or_dataset' };
      }

      await deps.collections.markTrainingState(
        {
          collectionId,
          trainingState: 'running',
          remainingTraining: 1,
          options: { timeoutMs: 5_000 },
        },
        context,
      );

      try {
        const collection = await deps.collections.get(
          { collectionId, options: { timeoutMs: 5_000 } },
          context,
        );
        const payload = asRecord(task.payload);
        const sourceType = readString(payload['sourceType']) ?? 'text';
        const sourceRef = readString(payload['sourceRef']) ?? collection.sourceRef ?? '';
        if (sourceRef.length === 0) {
          throw new ApiErrorException(
            createApiError({
              code: 501005,
              requestId: context.requestId,
              params: { taskId: task.taskId, from: 'parse', to: 'source_missing' },
            }),
          );
        }
        const read = await deps.sourceProvider.read(
          { datasetId, sourceType, sourceRef, options: { timeoutMs: 30_000 } },
          context,
        );
        const dataset = await deps.datasets.findByDatasetId({ datasetId }, context);
        if (!dataset) {
          throw new ApiErrorException(
            createApiError({
              code: 501070,
              requestId: context.requestId,
              params: { resourceType: 'dataset', resourceId: datasetId },
            }),
          );
        }
        const rawText = read.rawText ?? '';
        const policy =
          readPolicy(payload['policy']) ??
          readPolicy(collection.trainingPolicy) ??
          DEFAULT_CHUNK_POLICY;
        const chunks = chunkText({ text: rawText, policy }).chunks;

        if (chunks.length === 0) {
          await deps.collections.markTrainingState(
            {
              collectionId,
              trainingState: 'ready',
              remainingTraining: 0,
              options: { timeoutMs: 5_000 },
            },
            context,
          );
          return { state: 'success', producedItems: 0 };
        }

        const vectors = await deps.embedding.embed(
          {
            models: { embeddingModel: dataset.vectorModel },
            texts: chunks.map((chunk) => chunk.text),
            options: { timeoutMs: 60_000 },
          },
          context,
        );

        let produced = 0;
        for (const [index, chunk] of chunks.entries()) {
          await deps.inserts.insertDirect(
            {
              // dataId 必须是 24 位 ObjectId：由 collectionId + chunk 序号确定性派生，
              // 保证重复训练覆盖同一分块而不是每次新增。
              dataId: stableDataId(collectionId, index),
              datasetId,
              collectionId,
              q: chunk.text,
              indexType: 'default',
              chunkIndex: index,
              indexVersion: dataset.indexVersion,
              vector: vectors[index] ?? [],
              options: { timeoutMs: 15_000 },
            },
            context,
          );
          produced += 1;
        }

        await deps.collections.markTrainingState(
          {
            collectionId,
            trainingState: 'ready',
            remainingTraining: 0,
            options: { timeoutMs: 5_000 },
          },
          context,
        );
        return { state: 'success', producedItems: produced };
      } catch (error) {
        await deps.collections
          .markTrainingState(
            {
              collectionId,
              trainingState: 'error',
              remainingTraining: 0,
              options: { timeoutMs: 5_000 },
            },
            context,
          )
          .catch(() => undefined);
        if (error instanceof Error) {
          return { state: 'failed', errorMsg: error.message.slice(0, 200) };
        }
        return { state: 'failed', errorMsg: 'training_failed' };
      }
    },
  };
}

/** pushData 的 qa 任务：payload 携带 q/a，dataId 由投递方稳定生成。 */
async function processQa(
  deps: TrainingProcessorDeps,
  task: TaskEnvelope,
  context: RequestContext,
): Promise<TaskResult> {
  const datasetId = task.datasetId;
  const collectionId = task.collectionId;
  const dataId = task.dataId;
  if (!datasetId || !collectionId || !dataId) {
    return { state: 'failed', errorMsg: 'missing_qa_scope' };
  }
  const payload = asRecord(task.payload);
  const q = readString(payload['q']);
  if (!q) {
    return { state: 'failed', errorMsg: 'qa_missing_q' };
  }
  try {
    const dataset = await deps.datasets.findByDatasetId({ datasetId }, context);
    if (!dataset) {
      return { state: 'failed', errorMsg: 'training_dataset_missing' };
    }
    const vectors = await deps.embedding.embed(
      {
        models: { embeddingModel: dataset.vectorModel },
        texts: [q],
        options: { timeoutMs: 60_000 },
      },
      context,
    );
    await deps.inserts.insertDirect(
      {
        dataId,
        datasetId,
        collectionId,
        q,
        a: readString(payload['a']) ?? '',
        indexType: 'question',
        chunkIndex: 0,
        indexVersion: dataset.indexVersion,
        vector: vectors[0] ?? [],
        options: { timeoutMs: 15_000 },
      },
      context,
    );
    return { state: 'success', producedItems: 1 };
  } catch (error) {
    return {
      state: 'failed',
      errorMsg: error instanceof Error ? error.message.slice(0, 200) : 'qa_training_failed',
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readPolicy(value: unknown): ChunkPolicy | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const mode = candidate['mode'];
  const lengthUnit = candidate['lengthUnit'];
  if (
    (mode !== 'auto' && mode !== 'paragraph' && mode !== 'custom') ||
    (lengthUnit !== 'char' && lengthUnit !== 'token') ||
    typeof candidate['chunkSize'] !== 'number' ||
    typeof candidate['minSize'] !== 'number' ||
    typeof candidate['maxSize'] !== 'number' ||
    typeof candidate['overlapRatio'] !== 'number' ||
    typeof candidate['paragraphDeep'] !== 'number' ||
    typeof candidate['forceSplit'] !== 'boolean' ||
    typeof candidate['maxChunks'] !== 'number' ||
    !Array.isArray(candidate['customRegs'])
  ) {
    return undefined;
  }
  return candidate as unknown as ChunkPolicy;
}

function stableDataId(collectionId: string, index: number): string {
  return createHash('sha256').update(`${collectionId}:${index}`).digest('hex').slice(0, 24);
}
