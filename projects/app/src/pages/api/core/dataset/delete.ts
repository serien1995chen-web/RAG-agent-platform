import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../runtime';
import { authenticateRequest } from '../../../../runtime/auth';
import {
  parseDto,
  readIdempotencyKey,
  successResponse,
  withApiHandler,
} from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';

interface DatasetDeleteBody {
  datasetId: string;
  'Idempotency-Key': string;
}

const OWNER_PERMISSION = 8;

/** API-DS-005 POST /api/core/dataset/delete */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const headerIdempotencyKey = readIdempotencyKey(request);
    const rawBody =
      typeof request.body === 'object' && request.body !== null
        ? (request.body as Record<string, unknown>)
        : {};
    const body = parseDto<DatasetDeleteBody>('DatasetDeleteBody', {
      ...rawBody,
      ...(headerIdempotencyKey !== null ? { 'Idempotency-Key': headerIdempotencyKey } : {}),
    });
    const options = { timeoutMs: 30_000 };
    const permission = await runtime.datasetPermission.getPermission(
      { datasetId: body.datasetId, options },
      context,
    );
    if (!context.tenant.isRoot && (permission.permissionMask & OWNER_PERMISSION) === 0) {
      throw new ApiErrorException(
        createApiError({
          code: 501061,
          requestId,
          params: { datasetId: body.datasetId, permission: 'owner' },
        }),
      );
    }
    const result = await runtime.deleteService.requestDatasetDelete(
      { datasetId: body.datasetId, options },
      context,
    );
    response.status(200).json(successResponse(result, requestId));
  },
  { validationErrorCode: 501061 },
);
