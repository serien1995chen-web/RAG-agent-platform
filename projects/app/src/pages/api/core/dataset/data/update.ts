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

/** API-DATA-003 POST /api/core/dataset/data/update */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<DataUpdateBody>('DataUpdateBody', request.body);
    const repository = runtime.knowledgeItemRepository as typeof runtime.knowledgeItemRepository & {
      get?: (input: { dataId: string; options: typeof PORT_OPTIONS }) => Promise<{
        version: number;
        q?: string;
        a?: string;
        indexes: Array<{ indexId: string; type: string; dataId: string; text: string }>;
      } | null>;
    };
    const existing = await repository.get?.({ dataId: body.dataId, options: PORT_OPTIONS });
    if (!existing) {
      throw apiError(501070, requestId, { dataId: body.dataId });
    }
    if (existing.version !== body.version) {
      throw apiError(501067, requestId, { expected: existing.version, actual: body.version });
    }
    // 真实字段更新：q/a/indexes 三者都按请求改写，未提供的保留旧值；不再原样回写旧 indexes。
    const q = body.q ?? existing.q ?? '';
    const a = body.a ?? existing.a ?? '';
    const text = a.length > 0 ? `${q}\n${a}` : q;
    const indexes =
      body.indexes && body.indexes.length > 0
        ? body.indexes.map((patch) => {
            const previous = existing.indexes.find((index) => index.indexId === patch.indexId);
            return {
              indexId: patch.indexId,
              type: previous?.type ?? 'default',
              dataId: body.dataId,
              text: patch.text,
            };
          })
        : existing.indexes.map((index) =>
            index.type === 'default' || index.type === 'question' ? { ...index, text } : index,
          );
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
