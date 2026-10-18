import { createHash } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { JsonValue } from '@kb/contracts';
import { detectImageMimeType } from '@kb/service';
import type { RequestContext } from '@kb/service';
import {
  ImageApplicationService,
  type ImageMode,
} from '../../../../../packages/service/src/modules/item/application/index';
import { createImageAssetRepository } from '../../../../../packages/service/src/modules/item/repository/index';
import type { ExtendedAppRuntime } from '../../runtime';
import { verifyUploadToken } from '../../pages/api/core/dataset/file/presignUpload';

export interface ResolvedImageSource {
  imageId: string;
  dataId: string;
  bucket: string;
  key: string;
  mimeType: string;
  size: number;
}

function invalidSource(
  context: RequestContext,
  datasetId: string,
  source: string,
): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501061,
      requestId: context.requestId,
      params: {
        fileId: createHash('sha256').update(source).digest('hex').slice(0, 16),
        datasetId,
      },
    }),
  );
}

function refOf(
  runtime: ExtendedAppRuntime,
  context: RequestContext,
  datasetId: string,
  source: string,
): { bucket: string; key: string } {
  // fileRef 是不透明 HMAC token；裸 objectKey 仅兼容 dataset/<datasetId>/uploads/ 前缀。
  if (source.startsWith('dataset/')) {
    const prefix = `dataset/${datasetId}/uploads/`;
    if (!source.startsWith(prefix)) throw invalidSource(context, datasetId, source);
    return { bucket: runtime.config.system.s3.bucket, key: source };
  }
  if (source.includes('.')) {
    const payload = verifyUploadToken(source, context);
    if (payload.kind !== 'file' || payload.datasetId !== datasetId) {
      throw invalidSource(context, datasetId, source);
    }
    return { bucket: payload.bucket, key: payload.key };
  }
  throw invalidSource(context, datasetId, source);
}

/**
 * 校验并解析图片引用：token 归属/过期、对象存在、非空、体积上限、图片魔数。
 * 任一失败在创建集合/写入 Data 之前抛出，保证无半成品。
 */
export async function resolveImageSources(
  runtime: ExtendedAppRuntime,
  context: RequestContext,
  datasetId: string,
  sources: string[],
): Promise<ResolvedImageSource[]> {
  const limit = runtime.config.datasetRuntime.maxImagesPerRequest;
  if (sources.length < 1 || sources.length > limit) {
    throw new ApiErrorException(
      createApiError({
        code: 501030,
        requestId: context.requestId,
        params: { limit, actual: sources.length },
      }),
    );
  }
  const maxBytes = runtime.config.datasetRuntime.maxRequestBodyBytes;
  const resolved: ResolvedImageSource[] = [];
  for (const source of sources) {
    const ref = refOf(runtime, context, datasetId, source);
    const { body } = await runtime.ports.objectStore.get(
      {
        ref,
        datasetId,
        options: { timeoutMs: 30_000 },
      },
      context,
    );
    if (body.length === 0) {
      throw new ApiErrorException(
        createApiError({
          code: 501035,
          requestId: context.requestId,
          params: { contentType: 'image/empty', urlHash: '' },
        }),
      );
    }
    if (body.length > maxBytes) {
      throw new ApiErrorException(
        createApiError({
          code: 501065,
          requestId: context.requestId,
          params: { limitBytes: maxBytes, actualBytes: body.length, urlHash: '' },
        }),
      );
    }
    const mimeType = detectImageMimeType(body);
    if (mimeType === null) {
      throw new ApiErrorException(
        createApiError({
          code: 501035,
          requestId: context.requestId,
          params: { contentType: 'image/unknown', urlHash: '' },
        }),
      );
    }
    const stableId = createHash('sha256')
      .update(`${datasetId}:${ref.key}`)
      .digest('hex')
      .slice(0, 24);
    resolved.push({
      imageId: stableId,
      dataId: stableId,
      bucket: ref.bucket,
      key: ref.key,
      mimeType,
      size: body.length,
    });
  }
  return resolved;
}

export async function ingestResolvedImages(
  runtime: ExtendedAppRuntime,
  context: RequestContext,
  input: {
    datasetId: string;
    collectionId: string;
    indexVersion: string;
    mode: ImageMode;
    resolved: ResolvedImageSource[];
    options: { timeoutMs: number };
  },
): Promise<JsonValue[]> {
  const assets = createImageAssetRepository(runtime.clients.mongo as never);
  const fullText = runtime.fullTextStore ?? runtime.ports.fullTextStore;
  if (!assets || !fullText) {
    throw new ApiErrorException(
      createApiError({
        code: 501062,
        requestId: context.requestId,
        params: { dependency: 'image_pipeline' },
      }),
    );
  }
  const service = new ImageApplicationService({
    assets,
    items: runtime.knowledgeItemRepository,
    vectors: runtime.vectorController,
    fullText,
    processor: runtime.ports.imageTrainingProcessor,
  });
  const items: JsonValue[] = [];
  for (const source of input.resolved) {
    const result = await service.createImage(
      {
        imageId: source.imageId,
        datasetId: input.datasetId,
        collectionId: input.collectionId,
        dataId: source.dataId,
        bucketName: source.bucket,
        objectKey: source.key,
        mimeType: source.mimeType,
        size: source.size,
        mode: input.mode,
        indexVersion: input.indexVersion,
        options: input.options,
      },
      context,
    );
    items.push({
      imageId: source.imageId,
      dataId: source.dataId,
      state: result.state,
      errorMsg: result.errorMsg ?? null,
    });
  }
  return items;
}

export function assertImageCapability(runtime: ExtendedAppRuntime, requestId: string): void {
  if (runtime.imageCapability) return;
  throw new ApiErrorException(
    createApiError({
      code: 501010,
      requestId,
      params: { capabilities: ['vlm', 'imageEmbedding'] },
    }),
  );
}
