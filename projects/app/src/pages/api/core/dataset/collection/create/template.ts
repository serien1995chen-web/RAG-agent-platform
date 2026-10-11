import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../../runtime';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';
import { PORT_OPTIONS, apiError, sourceCollection } from '../../../../../../shared/import-source';

interface CollectionCreateTemplateForm {
  file?: unknown;
  datasetId: string;
  templateId: string;
}

/** API-COL-010 POST /api/core/dataset/collection/create/template */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateTemplateForm>(
      'CollectionCreateTemplateForm',
      request.body,
    );
    if (typeof body.templateId !== 'string' || body.templateId.length === 0) {
      throw apiError(501037, requestId, { templateId: '' });
    }
    const created = await runtime.collectionRepository.create(
      {
        collection: sourceCollection({
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          name: body.templateId,
          sourceRef: body.templateId,
        }),
        options: PORT_OPTIONS,
      },
      context,
    );
    response
      .status(200)
      .json(successResponse({ collectionId: created.collectionId, insertLen: 0 }, requestId));
  },
  { validationErrorCode: 501030 },
);