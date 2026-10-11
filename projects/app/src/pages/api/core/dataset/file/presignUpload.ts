import { randomUUID } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { MAX_RAW_TEXT_BYTES, apiError } from '../../../../../shared/import-source';
import { objectStoreOf } from '../../../../../shared/object-store';

interface PresignUploadBody {
  datasetId: string;
  filename: string;
  size: number;
  mime: string;
}

/** API-FILE-001 POST /api/core/dataset/file/presignUpload */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<PresignUploadBody>('PresignUploadBody', request.body);
    if (body.size > MAX_RAW_TEXT_BYTES) {
      throw apiError(501065, requestId, { limitBytes: MAX_RAW_TEXT_BYTES, actualBytes: body.size });
    }
    const store = objectStoreOf(runtime);
    if (!store) throw apiError(501017, requestId, { provider: 's3' });
    const fileId = randomUUID();
    const key = `dataset/${body.datasetId}/${fileId}`;
    const uploadUrl = await store.presignPut(
      { ref: { bucket: 'kb-source', key }, expiresSeconds: 900 },
      context,
    );
    response.status(200).json(
      successResponse(
        {
          uploadUrl,
          fileId,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
        requestId,
      ),
    );
  },
  { validationErrorCode: 501065 },
);