import { randomUUID } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface PresignSearchTestImageBody {
  filename: string;
  size: number;
  mime: string;
}

function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

/** API-FILE-005 POST /api/core/dataset/file/presignSearchTestImage */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<PresignSearchTestImageBody>('PresignSearchTestImageBody', request.body);
    if (typeof body.filename !== 'string' || body.filename.length === 0) {
      throw apiError(501065, requestId, { field: 'filename' });
    }
    const store = (runtime.clients as { objectStore?: { presignPut?: unknown } }).objectStore;
    if (!store || typeof store.presignPut !== 'function') {
      throw apiError(501017, requestId, { provider: 's3' });
    }
    const key = `temp/${context.tenant.teamId}/${randomUUID()}`;
    const url = await (
      store as { presignPut: (i: unknown, c: unknown) => Promise<string> }
    ).presignPut(
      { ref: { bucket: 'kb-image', key }, expiresSeconds: 7200 },
      { teamId: context.tenant.teamId },
    );
    response
      .status(200)
      .json(
        successResponse(
          { url, key, expiresAt: new Date(Date.now() + 7200 * 1000).toISOString() },
          requestId,
        ),
      );
  },
  { validationErrorCode: 501065 },
);
