import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

const PORT_OPTIONS = { timeoutMs: 10_000 } as const;
function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

interface IndexPatchValue {
  indexId: string;
  text: string;
  version: number;
}

interface DataUpdateBody {
  dataId: string;
  version: number;
  q?: string;
  a?: string;
  indexes?: IndexPatchValue[];
}

interface ExistingItem {
  version: number;
  q?: string;
  a?: string;
  datasetId: string;
  collectionId: string;
  indexes: Array<{ indexId: string; type: string; dataId: string; text: string }>;
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
      }) => Promise<ExistingItem | null>;
    };
    const existing = await repository.get?.({ dataId: body.dataId, options: PORT_OPTIONS });
    if (!existing) {
      throw apiError(501070, requestId, { dataId: body.dataId });
    }
    if (existing.version !== body.version) {
      throw apiError(501067, requestId, { expected: existing.version, actual: body.version });
    }
    // 真实更新：新向量 → Mongo CAS 切换 q/a/indexes → FullText（DataUpdateService）。
    const updated = await runtime.dataUpdateService.updateItem(
      {
        dataId: body.dataId,
        datasetId: existing.datasetId,
        collectionId: existing.collectionId,
        version: body.version,
        ...(body.q !== undefined ? { q: body.q } : {}),
        ...(body.a !== undefined ? { a: body.a } : {}),
        ...(body.indexes !== undefined ? { indexes: body.indexes } : {}),
        existing,
        options: PORT_OPTIONS,
      },
      context,
    );
    response
      .status(200)
      .json(successResponse({ dataId: updated.dataId, version: updated.version }, requestId));
  },
  { validationErrorCode: 501067 },
);
