import { ApiErrorException, createApiError } from '@kb/contracts';
import type { KnowledgeItemSnapshot, PortCallOptions, RequestContext } from '@kb/service';
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

interface DataDeleteBody {
  dataId: string;
  'Idempotency-Key': string;
}

interface KnowledgeItemLookupRepository {
  get(
    input: { dataId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<KnowledgeItemSnapshot>;
}

const OWNER_PERMISSION = 8;
const WRITE_PERMISSION = 2;

/** API-DATA-004 POST /api/core/dataset/data/delete */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const headerIdempotencyKey = readIdempotencyKey(request);
    const rawBody =
      typeof request.body === 'object' && request.body !== null
        ? (request.body as Record<string, unknown>)
        : {};
    const body = parseDto<DataDeleteBody>('DataDeleteBody', {
      ...rawBody,
      ...(headerIdempotencyKey !== null ? { 'Idempotency-Key': headerIdempotencyKey } : {}),
    });
    const options = { timeoutMs: 30_000 };
    const item = await (
      runtime.knowledgeItemRepository as typeof runtime.knowledgeItemRepository &
        KnowledgeItemLookupRepository
    ).get({ dataId: body.dataId, options }, context);
    const permission = await runtime.datasetPermission.getPermission(
      { datasetId: item.datasetId, options },
      context,
    );
    const allowed =
      context.tenant.isRoot ||
      (permission.permissionMask & OWNER_PERMISSION) !== 0 ||
      (permission.permissionMask & WRITE_PERMISSION) !== 0;
    if (!allowed) {
      throw new ApiErrorException(
        createApiError({
          code: 501027,
          requestId,
          params: { dataId: body.dataId, permission: 'write' },
        }),
      );
    }
    const result = await runtime.deleteService.requestDataDelete(
      { dataId: body.dataId, options },
      context,
    );
    response
      .status(200)
      .json(successResponse({ dataId: body.dataId, state: result.state }, requestId));
  },
  { validationErrorCode: 501027 },
);
