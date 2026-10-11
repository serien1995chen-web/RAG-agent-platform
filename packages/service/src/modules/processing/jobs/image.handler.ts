
/**
 * P4-06 image/imageParse Job Handler（设计文档 12.10 / 9.7）。
 * 自包含定义 handler，返回 Promise<TaskResult>；可被 createChainJobDispatch 注册。
 * payload 白名单：未识别字段丢弃，禁止透传正文/密钥。
 */
import { JOB_MODE_TO_QUEUE, QUEUE_NAMES } from "@kb/dal";
import type { ImageTrainingProcessorPort, TaskResult } from "../../../ports/capabilities";
import type { JobDefinition, JobEnvelope, RequestContext } from "../../../ports/types";

export const IMAGE_JOB_MODES = ["image", "imageParse"] as const;

export const IMAGE_JOB_DEFINITIONS: readonly JobDefinition[] = [
  {
    name: "processing-image",
    queue: JOB_MODE_TO_QUEUE.image ?? QUEUE_NAMES.image,
    modes: ["image"],
    stableIdTemplate: "teamId:datasetId:imageId:image",
  },
  {
    name: "processing-image-parse",
    queue: JOB_MODE_TO_QUEUE.imageParse ?? QUEUE_NAMES.imageParse,
    modes: ["imageParse"],
    stableIdTemplate: "teamId:datasetId:imageId:imageParse",
  },
];

export interface ImageJobHandlerDeps {
  processor: ImageTrainingProcessorPort;
}

const PAYLOAD_WHITELIST = ["imageRef"] as const;

/** 白名单化 payload：仅保留已知字段，丢弃正文/密钥等未识别内容。 */
export function whitelistImagePayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null) return {};
  const source = payload as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of PAYLOAD_WHITELIST) {
    if (key in source) result[key] = source[key];
  }
  return result;
}

export interface ImageJobHandler {
  handle(envelope: JobEnvelope, context: RequestContext): Promise<TaskResult>;
}

export function createImageJobHandler(deps: ImageJobHandlerDeps): ImageJobHandler {
  return {
    async handle(envelope: JobEnvelope, context: RequestContext): Promise<TaskResult> {
      const payload = whitelistImagePayload(envelope.payload);
      const imageRef = payload.imageRef as { bucket: string; key: string } | undefined;
      if (!imageRef?.bucket || !imageRef.key) {
        return { state: "failed", errorMsg: "imageRef_missing" };
      }
      const result = await deps.processor.processImage(
        {
          taskId: envelope.jobId,
          teamId: envelope.teamId,
          datasetId: envelope.datasetId,
          collectionId: envelope.collectionId,
          dataId: envelope.dataId,
          mode: envelope.mode,
          payload: { imageRef },
        },
        imageRef,
        context,
      );
      if (result.state === "success") return { state: "success", producedItems: 1 };
      return { state: "failed", errorMsg: result.errorMsg ?? "image_failed" };
    },
  };
}
