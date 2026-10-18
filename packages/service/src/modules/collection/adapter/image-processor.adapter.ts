/**
 * P4-06 image-processor adapter（设计文档 9.7 / 10.9）。
 * 把 ImageTrainingProcessorPort 适配为内部调用（VLM 描述 + 图片 Embedding）；
 * 能力缺失返回稳定 no-retry 分类；外部能力走 3.8.1 mock 合同。
 * 保留 embedding 在返回值中（对外结构仍满足 ImageTaskResult）。
 */
import { ApiErrorException, createApiError } from '@kb/contracts';
import type {
  ImageTaskResult,
  ImageTrainingProcessorPort,
  TaskEnvelope,
} from '../../../ports/capabilities';
import type { ObjectRef, RequestContext } from '../../../ports/types';

/** 内部结果类型：在 ImageTaskResult 基础上保留 embedding（RK-08a）。 */
export interface ImageProcessingOutcome extends ImageTaskResult {
  embedding?: number[];
}

export interface ImageCapabilityPort {
  describeImage(
    input: {
      imageRef: ObjectRef;
      datasetId: string;
      mode: 'chunk' | 'image' | 'imageParse';
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ description: string; embedding: number[] }>;
}

export interface ImageProcessorAdapterOptions {
  capability?: ImageCapabilityPort;
  configured?: boolean;
  mock?: boolean;
  environment?: string;
}

export function createImageProcessorAdapter(
  options: ImageProcessorAdapterOptions = {},
): ImageTrainingProcessorPort {
  const configured = options.configured ?? true;
  return {
    async processImage(
      task: TaskEnvelope<{ imageRef: ObjectRef }>,
      imageRef: ObjectRef,
      context: RequestContext,
    ): Promise<ImageTaskResult> {
      const imageId = task.payload.imageRef?.key ?? imageRef.key;
      if (!configured || !options.capability) {
        return { imageId, state: 'failed', errorMsg: '501062:image_capability_not_configured' };
      }
      if (options.mock && options.environment === 'production') {
        throw new ApiErrorException(
          createApiError({
            code: 501063,
            requestId: context.requestId,
            params: { dependency: 'image_processor', environment: 'production' },
          }),
        );
      }
      try {
        const mode = task.mode === 'chunk' || task.mode === 'imageParse' ? task.mode : 'image';
        const result = await options.capability.describeImage(
          { imageRef, datasetId: task.datasetId ?? '', mode, options: { timeoutMs: 30000 } },
          context,
        );
        const outcome: ImageProcessingOutcome = {
          imageId,
          state: 'success',
          description: result.description,
          embedding: result.embedding,
        };
        return outcome;
      } catch (error) {
        const detail =
          error instanceof ApiErrorException
            ? `${error.error.code}:${error.error.messageKey}`
            : error instanceof Error
              ? error.message
              : 'image_processor_failed';
        return { imageId, state: 'failed', errorMsg: detail.slice(0, 200) };
      }
    },
  };
}
