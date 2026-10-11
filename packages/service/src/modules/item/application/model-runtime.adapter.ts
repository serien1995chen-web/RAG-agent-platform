import { ApiErrorException, createApiError } from '@kb/contracts';
import type {
  ImageTaskResult,
  ImageTrainingProcessorPort,
  ModelRegistryPort,
} from '../../../ports/capabilities';
import type { PortCallOptions, RequestContext } from '../../../ports/types';

export type ModelRuntimeMode = 'mock' | 'real';

export interface ModelRuntimeDeps {
  mode: ModelRuntimeMode;
  modelRegistry?: ModelRegistryPort;
  embeddingDimension?: number;
}

/** 确定性 mock 向量：同一文本恒定、非空，供 mock 合同下的真实写入路径使用。 */
function deterministicEmbedding(text: string, dimension: number): number[] {
  let seed = 2166136261;
  for (const char of text) {
    seed ^= char.codePointAt(0) ?? 0;
    seed = Math.imul(seed, 16777619) >>> 0;
  }
  const vector = new Array<number>(dimension);
  let state = seed || 1;
  for (let i = 0; i < dimension; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    vector[i] = (state / 0xffffffff) * 2 - 1;
  }
  return vector;
}

/**
 * Rev2 内部模型适配器：基于既有 ModelRegistryPort + 配置提供 embedText / describeImage。
 * mock 模式用确定性实现；real 模式缺配置返回 501062/501063，绝不返回 501999。
 */
export class ModelRuntimeAdapter {
  private readonly dimension: number;

  constructor(private readonly deps: ModelRuntimeDeps) {
    this.dimension = deps.embeddingDimension ?? 1536;
  }

  get mode(): ModelRuntimeMode {
    return this.deps.mode;
  }

  async embedText(
    input: { text: string; modelId?: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<number[]> {
    if (this.deps.mode === 'mock') {
      return deterministicEmbedding(input.text, this.dimension);
    }
    const models =
      (await this.deps.modelRegistry?.listModels(
        { capability: 'embedding', options: input.options },
        context,
      )) ?? [];
    if (models.length === 0) {
      throw new ApiErrorException(
        createApiError({
          code: 501062,
          requestId: context.requestId,
          params: { dependency: 'model', capability: 'embedding' },
        }),
      );
    }
    throw new ApiErrorException(
      createApiError({
        code: 501063,
        requestId: context.requestId,
        params: { dependency: 'model', capability: 'embedding' },
      }),
    );
  }

  async describeImage(
    input: { objectKey: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<string> {
    if (this.deps.mode === 'mock') {
      return `mock-image-description:${input.objectKey.split('/').pop() ?? 'image'}`;
    }
    const models =
      (await this.deps.modelRegistry?.listModels(
        { capability: 'vlm', options: input.options },
        context,
      )) ?? [];
    if (models.length === 0) {
      throw new ApiErrorException(
        createApiError({
          code: 501062,
          requestId: context.requestId,
          params: { dependency: 'model', capability: 'vlm' },
        }),
      );
    }
    throw new ApiErrorException(
      createApiError({
        code: 501063,
        requestId: context.requestId,
        params: { dependency: 'model', capability: 'vlm' },
      }),
    );
  }
}

/**
 * Rev2：以 ModelRuntimeAdapter 实现 ImageTrainingProcessorPort，替换默认 501999 桩。
 * mock 模式返回确定性 description+embedding；real 模式缺配置由其内部返回 501062/501063。
 */
export function createImageProcessorRuntime(
  modelRuntime: ModelRuntimeAdapter,
): ImageTrainingProcessorPort {
  return {
    async processImage(task, imageRef, context): Promise<ImageTaskResult> {
      const options: PortCallOptions = { timeoutMs: 30_000 };
      try {
        const description = await modelRuntime.describeImage(
          { objectKey: imageRef.key, options },
          context,
        );
        const embedding = await modelRuntime.embedText({ text: description, options }, context);
        return {
          imageId: task.dataId ?? imageRef.key,
          state: 'success',
          description,
          ...{ embedding },
        } as ImageTaskResult & { embedding: number[] };
      } catch (error) {
        return {
          imageId: task.dataId ?? imageRef.key,
          state: 'failed',
          errorMsg: error instanceof Error ? error.message : 'image_processor_failed',
        };
      }
    },
  };
}
