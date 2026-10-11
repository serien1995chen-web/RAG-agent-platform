import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { PORT_OPTIONS, apiError } from '../../../../../shared/import-source';

interface DataUpdateBody {
  dataId: string;
  version: number;
  q?: string;
  a?: string;
}

/** API-DATA-003 POST /api/core/dataset/data/update */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<DataUpdateBody>('DataUpdateBody', request.body);
    const repository = runtime.knowledgeItemRepository as typeof runtime.knowledgeItemRepository & {
      get?: (input: {
        dataId: string;
        options: typeof PORT_OPTIONS;
      }) => Promise<{ version: number; indexes: [] } | null>;
    };
    const existing = await repository.get?.({ dataId: body.dataId, options: PORT_OPTIONS });
    if (existing && existing.version !== body.version) {
      throw apiError(501067, requestId, {
        expected: existing.version,
        actual: body.version,
      });
    }
    const indexes = existing?.indexes ?? [];
    const updated = await runtime.knowledgeItemRepository.updateIndexes(
      { dataId: body.dataId, version: body.version, indexes, options: PORT_OPTIONS },
      context,
    );
    response
      .status(200)
      .json(successResponse({ dataId: body.dataId, version: updated.version }, requestId));
  },
  { validationErrorCode: 501067 },
);
