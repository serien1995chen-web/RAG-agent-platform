import { randomUUID } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { UPLOAD_PART_PATH } from './presignUpload';

interface PresignSearchTestImageBody {
  filename: string;
  size: number;
  mime: string;
}

const SEARCH_IMAGE_TTL_MS = 15 * 60 * 1000;

function extensionOf(filename: string): string {
  const match = /(\.[A-Za-z0-9]{1,12})$/.exec(filename);
  return match?.[1] ?? '';
}

/** API-FILE-005 POST /api/core/dataset/file/presignSearchTestImage */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<PresignSearchTestImageBody>('PresignSearchTestImageBody', request.body);
    const expiresAt = Date.now() + SEARCH_IMAGE_TTL_MS;
    const key = `temp/${context.tenant.teamId}/${expiresAt}/${randomUUID()}${extensionOf(
      body.filename,
    )}`;
    response
      .status(200)
      .json(
        successResponse(
          { url: UPLOAD_PART_PATH, key, expiresAt: new Date(expiresAt).toISOString() },
          requestId,
        ),
      );
  },
  { validationErrorCode: 501065 },
);
