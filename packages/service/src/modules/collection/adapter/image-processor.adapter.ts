
/**
 * P4-06 image-processor adapter（设计文档 9.7 / 10.9）。
 * 把 ImageTrainingProcessorPort 适配为内部调用（VLM 描述 + 图片 Embedding）；
 * 能力缺失返回稳定 no-retry 分类；外部能力走 3.8.1 mock 合同。
 */
import { ApiErrorException, createApiError } from "@kb/contracts";
import type {
  ImageTaskResult,
  ImageTrainingProcessorPort,
  TaskEnvelope,
} from "../../../ports/capabilities";
import type { ObjectRef, RequestContext } from "../../../ports/types";

export interface ImageCapabilityPort {
  describeImage(input: { imageRef: ObjectRef; options: { timeoutMs: number } }, context: RequestContext): Promise<{ description: string; embedding: number[] }>;
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
    async processImage(task: TaskEnvelope<{ imageRef: ObjectRef }>, imageRef: ObjectRef, context: RequestContext): Promise<ImageTaskResult> {
      const imageId = task.payload.imageRef?.key ?? imageRef.key;
      if (!configured || !options.capability) {
        return { imageId, state: "failed", errorMsg: "501062:image_capability_not_configured" };
      }
      if (options.mock && options.environment === "production") {
        throw new ApiErrorException(
          createApiError({ code: 501063, requestId: context.requestId, params: { dependency: "image_processor", environment: "production" } }),
        );
      }
      try {
        const result = await options.capability.describeImage({ imageRef, options: { timeoutMs: 30000 } }, context);
        return { imageId, state: "success", description: result.description };
      } catch {
        return { imageId, state: "failed", errorMsg: "image_processor_failed" };
      }
    },
  };
}
