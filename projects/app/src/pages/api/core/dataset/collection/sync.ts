import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { readIdempotencyKey } from '../../../../../shared/api/idempotency';

interface CollectionSyncBody {
  collectionId: string;
  'Idempotency-Key': string;
}

/** API-COL-015 POST /api/core/dataset/collection/sync */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    if (!context.permission.canWrite) {
      throw new ApiErrorException(
        createApiError({
          code: 501061,
          requestId,
          params: { permission: 'write' },
        }),
      );
    }

    const headerIdempotencyKey = readIdempotencyKey(request);
    const body = parseDto<CollectionSyncBody>('CollectionSyncBody', {
      ...(typeof request.body === 'object' && request.body !== null ? request.body : {}),
      ...(headerIdempotencyKey !== null ? { 'Idempotency-Key': headerIdempotencyKey } : {}),
    });
    const idempotencyKey = headerIdempotencyKey ?? body['Idempotency-Key'];
    const result = await runtime.datasetSyncService.enqueueManualSync(
      {
        collectionId: body.collectionId,
        idempotencyKey,
        options: { timeoutMs: 5_000 },
      },
      context,
    );
    response.status(200).json(successResponse(result, requestId));
  },
  { validationErrorCode: 501019 },
);
