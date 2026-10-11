import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../../runtime';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';
import {
  MAX_RAW_TEXT_BYTES,
  PORT_OPTIONS,
  apiError,
  createImportSourceService,
  resolveSourceProvider,
  sourceCollection,
} from '../../../../../../shared/import-source';

interface CollectionCreateFileBody {
  datasetId: string;
  fileId: string;
  rawText?: string;
}

/** API-COL-003 POST /api/core/dataset/collection/create/file */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateFileBody>('CollectionCreateFileBody', request.body);
    const useRawText = typeof body.rawText === 'string' && body.rawText.trim().length > 0;
    if (useRawText) {
      const actualBytes = Buffer.byteLength(body.rawText!, 'utf8');
      if (actualBytes > MAX_RAW_TEXT_BYTES) {
        throw apiError(501030, requestId, { limitBytes: MAX_RAW_TEXT_BYTES, actualBytes });
      }
    }
    const sourceType = useRawText ? 'text' : 'file';
    const sourceRef = useRawText ? body.rawText! : body.fileId;
    const service = createImportSourceService(runtime, resolveSourceProvider(sourceType));
    const result = await service.createCollectionFromSource(
      {
        collection: sourceCollection({
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          name: body.fileId,
          sourceRef,
        }),
        sourceType,
        sourceRef,
        options: PORT_OPTIONS,
      },
      context,
    );
    response
      .status(200)
      .json(
        successResponse(
          { collectionId: result.collectionId, insertLen: result.insertLen },
          requestId,
        ),
      );
  },
  { validationErrorCode: 501030 },
);