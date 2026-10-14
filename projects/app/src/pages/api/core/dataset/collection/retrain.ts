import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import {
  parseDto,
  readIdempotencyKey,
  successResponse,
  withApiHandler,
} from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { CollectionRetrainService } from '../../../../../../../../packages/service/src/modules/collection/application/retrain.service';
import type { ChunkPolicyValue } from '../../../../../../../../packages/service/src/shared/persistence';

interface CollectionRetrainBody {
  collectionId: string;
  policy: ChunkPolicyValue;
  'Idempotency-Key': string;
}

const OWNER_PERMISSION = 8;
const WRITE_PERMISSION = 2;

/** API-COL-014 POST /api/core/dataset/collection/retrain */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const headerIdempotencyKey = readIdempotencyKey(request);
    const rawBody =
      typeof request.body === 'object' && request.body !== null
        ? (request.body as Record<string, unknown>)
        : {};
    const body = parseDto<CollectionRetrainBody>('CollectionRetrainBody', {
      ...rawBody,
      ...(headerIdempotencyKey !== null ? { 'Idempotency-Key': headerIdempotencyKey } : {}),
    });
    const options = { timeoutMs: 30_000 };
    let collection;
    let permission;
    try {
      collection = await runtime.collectionRepository.get(
        { collectionId: body.collectionId, options },
        context,
      );
      permission = await runtime.datasetPermission.getPermission(
        { datasetId: collection.datasetId, options },
        context,
      );
    } catch (error) {
      if (error instanceof ApiErrorException && error.error.code === 501070) {
        throw new ApiErrorException(
          createApiError({
            code: 501069,
            requestId,
            params: { collectionId: body.collectionId, reason: 'not_found' },
          }),
        );
      }
      throw error;
    }
    const allowed =
      context.tenant.isRoot ||
      (permission.permissionMask & OWNER_PERMISSION) !== 0 ||
      (permission.permissionMask & WRITE_PERMISSION) !== 0;
    if (!allowed) {
      throw new ApiErrorException(
        createApiError({
          code: 501069,
          requestId,
          params: { collectionId: body.collectionId, permission: 'write' },
        }),
      );
    }

    const service = new CollectionRetrainService({
      collections: runtime.collectionRepository,
      items: runtime.knowledgeItemRepository,
      fullText: runtime.fullTextStore ?? runtime.ports.fullTextStore,
      vectors: runtime.vectorController,
      processing: runtime.processingService,
      trainingProcessor: runtime.ports.trainingProcessor,
      tenantQuota: runtime.ports.tenantQuotaProvider,
    });
    const result = await service.retrain(
      {
        collectionId: body.collectionId,
        policy: body.policy,
        idempotencyKey: headerIdempotencyKey ?? body['Idempotency-Key'],
        options,
      },
      context,
    );
    response.status(200).json(successResponse(result, requestId));
  },
  { validationErrorCode: 501069 },
);
