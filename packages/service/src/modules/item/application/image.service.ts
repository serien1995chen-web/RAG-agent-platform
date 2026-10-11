/**
 * P4-06 图片上传、TTL 与 image/imageParse 生产端（设计文档 9.7 / 10.9 / BR-WRITE-004/005）。
 * 上传 -> 7 天 TTL -> image/imageParse Task -> imageDescMap/imageEmbedding -> Data/Index -> 移除 TTL。
 * 单图结果键 teamId:datasetId:imageId:mode 幂等（operationId 由 buildImageJobId 派生）；
 * 单图失败必须可见，不隐藏。embedding 由处理器返回并写入图片向量（RK-08a）。
 */
import { buildImageJobId } from '@kb/dal';
import type {
  FullTextStore,
  ImageTaskResult,
  ImageTrainingProcessorPort,
  TaskResult,
  VectorController,
} from '../../../ports/capabilities';
import type { KnowledgeItemRepository } from '../../../ports/repositories';
import type {
  KnowledgeItemIndexValue,
  KnowledgeItemSnapshot,
  PortCallOptions,
  RequestContext,
} from '../../../ports/types';

export type ImageMode = 'image' | 'imageParse';

export interface ImageAssetRecord {
  imageId: string;
  teamId: string;
  datasetId: string;
  collectionId: string | null;
  objectKey: string;
  mimeType: string;
  size: number;
  ttlExpireAt: Date | null;
  persistent: boolean;
  state: 'temporary' | 'referenced' | 'deleting' | 'deleted' | 'failed';
}

export interface ImageApplicationServiceDeps {
  assets: {
    createTemporary(
      input: {
        imageId: string;
        datasetId: string;
        collectionId?: string | null;
        objectKey: string;
        bucketName: string;
        mimeType: string;
        size: number;
        operationId: string;
      },
      context: RequestContext,
    ): Promise<ImageAssetRecord>;
    findById(imageId: string, context: RequestContext): Promise<ImageAssetRecord | null>;
    promoteToReferenced(
      imageId: string,
      collectionId: string,
      context: RequestContext,
    ): Promise<ImageAssetRecord | null>;
    markFailed(imageId: string, reason: string, context: RequestContext): Promise<void>;
  };
  items: KnowledgeItemRepository;
  vectors: VectorController;
  fullText: FullTextStore;
  processor: ImageTrainingProcessorPort;
  emit?: (event: { type: string; dataId: string; teamId: string }) => void;
}

export interface CreateImageInput {
  imageId: string;
  datasetId: string;
  collectionId: string;
  dataId: string;
  bucketName: string;
  objectKey: string;
  mimeType: string;
  size: number;
  mode: ImageMode;
  vector?: number[];
  options: PortCallOptions;
}

/** BR-WRITE-005：auto 在输入预处理层改写为 chunk + autoIndexes=true，绝不持久化 mode=auto。 */
export function normalizeImageMode(mode: ImageMode | 'auto'): {
  mode: 'image' | 'imageParse' | 'chunk';
  autoIndexes: boolean;
} {
  if (mode === 'auto') return { mode: 'chunk', autoIndexes: true };
  return { mode, autoIndexes: false };
}

export class ImageApplicationService {
  constructor(private readonly deps: ImageApplicationServiceDeps) {}

  async createImage(input: CreateImageInput, context: RequestContext): Promise<TaskResult> {
    // 稳定 operationId：teamId:datasetId:imageId:mode（重复处理不产生第二条 Data / 不重复计费）。
    const operationId = buildImageJobId(
      context.tenant.teamId,
      input.datasetId,
      input.imageId,
      input.mode,
    );
    await this.deps.assets.createTemporary(
      {
        imageId: input.imageId,
        datasetId: input.datasetId,
        collectionId: input.collectionId,
        objectKey: input.objectKey,
        bucketName: input.bucketName,
        mimeType: input.mimeType,
        size: input.size,
        operationId,
      },
      context,
    );
    try {
      const processed = (await this.deps.processor.processImage(
        {
          taskId: input.dataId,
          teamId: context.tenant.teamId,
          datasetId: input.datasetId,
          collectionId: input.collectionId,
          dataId: input.dataId,
          mode: input.mode,
          payload: { imageRef: { bucket: input.bucketName, key: input.objectKey } },
        },
        { bucket: input.bucketName, key: input.objectKey },
        context,
      )) as ImageTaskResult & { embedding?: number[] };

      if (processed.state !== 'success') {
        await this.deps.assets.markFailed(
          input.imageId,
          processed.errorMsg ?? 'image_failed',
          context,
        );
        return {
          state: 'failed',
          producedItems: 0,
          errorMsg: processed.errorMsg ?? 'image_failed',
        };
      }

      const now = new Date().toISOString();
      const text = processed.description ?? '';
      const embedding =
        processed.embedding && processed.embedding.length > 0
          ? processed.embedding
          : (input.vector ?? []);

      const indexes: KnowledgeItemIndexValue[] = [
        { indexId: input.dataId + ':image', type: 'image', dataId: input.dataId, text },
      ];
      if (embedding.length > 0) {
        indexes.push({
          indexId: input.dataId + ':imageEmbedding',
          type: 'imageEmbedding',
          dataId: input.dataId,
          text,
        });
      }
      const item: KnowledgeItemSnapshot = {
        dataId: input.dataId,
        teamId: context.tenant.teamId,
        datasetId: input.datasetId,
        collectionId: input.collectionId,
        imageId: input.imageId,
        q: text,
        metadata: { imageDescMap: { [input.mode]: text } },
        indexes,
        rebuilding: false,
        version: 1,
        createTime: now,
        updateTime: now,
      };

      if (embedding.length > 0) {
        await this.deps.vectors.insert(
          {
            records: [
              {
                dataId: input.dataId,
                teamId: context.tenant.teamId,
                datasetId: input.datasetId,
                collectionId: input.collectionId,
                indexId: input.dataId + ':imageEmbedding',
                indexVersion: '1',
                vector: embedding,
              },
            ],
            options: input.options,
          },
          context,
        );
      }
      await this.deps.items.bulkUpsert({ items: [item], options: input.options }, context);
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
      await this.deps.assets.promoteToReferenced(input.imageId, input.collectionId, context);
      this.deps.emit?.({
        type: 'image.referenced',
        dataId: input.dataId,
        teamId: context.tenant.teamId,
      });
      return { state: 'success', producedItems: 1 };
    } catch (error) {
      await this.deps.assets.markFailed(input.imageId, 'image_pipeline_failed', context);
      return {
        state: 'failed',
        producedItems: 0,
        errorMsg: error instanceof Error ? error.message : 'image_pipeline_failed',
      };
    }
  }
}
