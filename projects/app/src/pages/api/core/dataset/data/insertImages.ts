import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import {
  MAX_IMAGES_PER_REQUEST,
  apiError,
  normalizeTrainingType,
} from '../../../../../shared/import-source';

interface InsertImagesBody {
  collectionId: string;
  files: string[];
  trainingType?: string;
  autoIndexes?: boolean;
}

/** API-DATA-006 POST /api/core/dataset/data/insertImages */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<InsertImagesBody>('InsertImagesBody', request.body);
    if (body.files.length === 0 || body.files.length > MAX_IMAGES_PER_REQUEST) {
      throw apiError(501065, requestId, {
        limit: MAX_IMAGES_PER_REQUEST,
        actual: body.files.length,
      });
    }
    const prefix = `temp/${context.tenant.teamId}/`;
    for (const file of body.files) {
      if (!file.startsWith(prefix)) throw apiError(501009, requestId, {});
    }
    const normalized = normalizeTrainingType(body.trainingType);
    const items = body.files.map((file) => ({
      file,
      state: 'pending',
      mode: normalized.mode,
      autoIndexes: normalized.autoIndexes,
    }));
    response.status(200).json(successResponse({ items }, requestId));
  },
  { validationErrorCode: 501010 },
);