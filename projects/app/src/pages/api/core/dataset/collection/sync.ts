import { ApiErrorException, createApiError } from '@kb/contracts';
import { BullMqQueueAdapter } from '@kb/dal';
import type { NextApiRequest, NextApiResponse } from 'next';
import { DatasetSyncApplicationService } from '../../../../../../../../packages/service/src/modules/collection/application/sync.service';
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
    const queue = new BullMqQueueAdapter({ connection: runtime.clients.redis });
    try {
      const service = new DatasetSyncApplicationService({
        collections: runtime.collectionRepository,
        knowledgeBase: runtime.knowledgeBaseRepository,
        processingJobs: runtime.processingRepository,
        queue,
      });
      const result = await service.enqueueManualSync(
        {
          collectionId: body.collectionId,
          idempotencyKey,
          options: { timeoutMs: 5_000 },
        },
        context,
      );
      response.status(200).json(successResponse(result, requestId));
    } finally {
      await queue.close();
    }
  },
  { validationErrorCode: 501019 },
);
