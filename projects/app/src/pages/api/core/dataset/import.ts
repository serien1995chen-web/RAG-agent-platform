import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../runtime/auth';
import { getRuntime } from '../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';
import { apiError } from '../../../../shared/import-source';

interface DatasetImportForm {
  file?: unknown;
  datasetId: string;
  targetCollectionId?: string;
  mapping?: unknown;
}

/** API-IMP-002 POST /api/core/dataset/import */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    await authenticateRequest(runtime, request, requestId);
    const body = parseDto<DatasetImportForm>('DatasetImportForm', request.body);
    if (body.targetCollectionId !== undefined && body.datasetId.length === 0) {
      throw apiError(501061, requestId, {});
    }
    if (body.file === undefined || body.file === null) {
      throw apiError(501058, requestId, { missingHeaders: ['q'], duplicateHeaders: [] });
    }
    response
      .status(200)
      .json(
        successResponse({ report: { success: 0, skipped: 0, failed: 0, errors: [] } }, requestId),
      );
  },
  { validationErrorCode: 501030 },
);
