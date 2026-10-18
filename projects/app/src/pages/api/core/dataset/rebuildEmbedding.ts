import { ApiErrorException, createApiError } from '@kb/contracts';
import type { ModelReference } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../runtime';
import { authenticateRequest } from '../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';
import { IndexVersionSwitchService } from '../../../../../../../packages/service/src/modules/index/application';
import {
  RebuildEmbeddingService,
  type RebuildItemRepository,
} from '../../../../../../../packages/service/src/modules/knowledge-base/application/rebuild.service';

interface RebuildEmbeddingBody {
  datasetId: string;
  modelRef: ModelReference;
}

const OWNER_PERMISSION = 8;

/**
 * ISSUE-006：`ModelReference.dimension` 的 refinement 属于维度校验，
 * 语义码保持 501013；其余 DTO 错误归入 501072。
 */
function isDimensionIssue(issues: unknown): boolean {
  if (!Array.isArray(issues)) return false;
  return issues.some((issue) => {
    const path = (issue as { path?: unknown }).path;
    return Array.isArray(path) && path.join('.') === 'modelRef.dimension';
  });
}

/** API-DS-006 POST /api/core/dataset/rebuildEmbedding */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<RebuildEmbeddingBody>('RebuildEmbeddingBody', request.body);
    const options = { timeoutMs: 30_000 };
    let permission;
    try {
      permission = await runtime.datasetPermission.getPermission(
        { datasetId: body.datasetId, options },
        context,
      );
    } catch (error) {
      if (error instanceof ApiErrorException && error.error.code === 501070) {
        throw new ApiErrorException(
          createApiError({
            code: 501013,
            requestId,
            params: { datasetId: body.datasetId, reason: 'not_found' },
          }),
        );
      }
      throw error;
    }
    if (!context.tenant.isRoot && (permission.permissionMask & OWNER_PERMISSION) === 0) {
      throw new ApiErrorException(
        createApiError({
          code: 501013,
          requestId,
          params: { datasetId: body.datasetId, permission: 'owner' },
        }),
      );
    }

    const items = runtime.knowledgeItemRepository as RebuildItemRepository;
    const fullText = runtime.fullTextStore ?? runtime.ports.fullTextStore;
    const service = new RebuildEmbeddingService({
      knowledgeBase: runtime.knowledgeBaseRepository,
      collections: runtime.collectionRepository,
      items,
      processing: runtime.processingService,
      embedding: runtime.embeddingService,
      vectors: runtime.vectorController,
      fullText,
      indexVersionSwitch: new IndexVersionSwitchService({
        store: runtime.knowledgeBaseRepository,
      }),
    });
    const result = await service.requestRebuild(
      { datasetId: body.datasetId, modelRef: body.modelRef, options },
      context,
    );
    response.status(200).json(successResponse(result, requestId));
  },
  {
    // ISSUE-006：普通缺参/类型错误走通用输入错误码；
    // 维度不匹配属于存储语义，仍返回 501013（设计 12.4）。
    validationErrorCode: (issues) => (isDimensionIssue(issues) ? 501013 : 501072),
  },
);
