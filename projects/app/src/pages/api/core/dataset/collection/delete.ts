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

interface CollectionDeleteBody {
  collectionId: string;
  'Idempotency-Key': string;
}

const OWNER_PERMISSION = 8;
const WRITE_PERMISSION = 2;

/** API-COL-013 POST /api/core/dataset/collection/delete */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const headerIdempotencyKey = readIdempotencyKey(request);
    const rawBody =
      typeof request.body === 'object' && request.body !== null
        ? (request.body as Record<string, unknown>)
        : {};
    const body = parseDto<CollectionDeleteBody>('CollectionDeleteBody', {
      ...rawBody,
      ...(headerIdempotencyKey !== null ? { 'Idempotency-Key': headerIdempotencyKey } : {}),
    });
    const options = { timeoutMs: 30_000 };
    const existing = await runtime.deleteService.getDeleteJobByScope(
      { scope: { kind: 'collection', collectionId: body.collectionId }, options },
      context,
    );
    if (existing) {
      const permission = await runtime.datasetPermission.getPermission(
        { datasetId: existing.datasetId, options },
        context,
      );
      const allowed =
        context.tenant.isRoot ||
        (permission.permissionMask & OWNER_PERMISSION) !== 0 ||
        (permission.permissionMask & WRITE_PERMISSION) !== 0;
      if (!allowed) {
        throw new ApiErrorException(
          createApiError({
            code: 501070,
            requestId,
            params: { collectionId: body.collectionId, permission: 'write' },
          }),
        );
      }
      const replayed = await runtime.deleteService.requestCollectionDelete(
        { collectionId: body.collectionId, options },
        context,
      );
      response.status(200).json(successResponse(replayed, requestId));
      return;
    }
    const collection = await runtime.collectionRepository.get(
      { collectionId: body.collectionId, options },
      context,
    );
    const permission = await runtime.datasetPermission.getPermission(
      { datasetId: collection.datasetId, options },
      context,
    );
    const allowed =
      context.tenant.isRoot ||
      (permission.permissionMask & OWNER_PERMISSION) !== 0 ||
      (permission.permissionMask & WRITE_PERMISSION) !== 0;
    if (!allowed) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId,
          params: { collectionId: body.collectionId, permission: 'write' },
        }),
      );
    }
    const result = await runtime.deleteService.requestCollectionDelete(
      { collectionId: body.collectionId, ownerTmbId: permission.owner, options },
      context,
    );
    response.status(200).json(successResponse(result, requestId));
  },
  { validationErrorCode: 501070 },
);
