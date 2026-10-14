import { ApiErrorException, createApiError } from '@kb/contracts';
import type { ModelReference } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../runtime';
import { authenticateRequest } from '../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';
import {
  IndexVersionSwitchService,
  IndexingService,
} from '../../../../../../../packages/service/src/modules/index/application';
import type { KnowledgeItemQueryRepository } from '../../../../../../../packages/service/src/modules/item/domain';
import { RebuildEmbeddingService } from '../../../../../../../packages/service/src/modules/knowledge-base/application/rebuild.service';

interface RebuildEmbeddingBody {
  datasetId: string;
  modelRef: ModelReference;
}

const OWNER_PERMISSION = 8;

/** API-DS-006 POST /api/core/dataset/rebuildEmbedding */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<RebuildEmbeddingBody>('RebuildEmbeddingBody', request.body);
    const options = { timeoutMs: 30_000 };
    const permission = await runtime.datasetPermission.getPermission(
      { datasetId: body.datasetId, options },
      context,
    );
    if (!context.tenant.isRoot && (permission.permissionMask & OWNER_PERMISSION) === 0) {
      throw new ApiErrorException(
        createApiError({
          code: 501013,
          requestId,
          params: { datasetId: body.datasetId, permission: 'owner' },
        }),
      );
    }

    const items = runtime.knowledgeItemRepository as KnowledgeItemQueryRepository;
    const fullText = runtime.fullTextStore ?? runtime.ports.fullTextStore;
    const service = new RebuildEmbeddingService({
      knowledgeBase: runtime.knowledgeBaseRepository,
      collections: runtime.collectionRepository,
      items,
      processing: runtime.processingService,
      embedding: runtime.embeddingService,
      indexing: new IndexingService({
        items,
        vectors: runtime.vectorController,
        fullText,
      }),
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
  { validationErrorCode: 501013 },
);
