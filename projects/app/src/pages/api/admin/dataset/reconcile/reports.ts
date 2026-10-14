import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface ReconcileReportsQueryDto {
  window: string;
  scope: { teamIds?: string[]; datasetIds?: string[]; collectionIds?: string[] };
  state?: 'running' | 'completed' | 'failed' | 'pending_review';
  page?: number;
}

const WINDOW_PATTERN = /^[1-9][0-9]{0,2}h$/;
const MAX_WINDOW_HOURS = 168;

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function invalidQuery(requestId: string, field: string, value: unknown): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501070,
      requestId,
      params: { resourceType: `reconcile_query.${field}`, resourceId: String(value ?? '') },
    }),
  );
}

/** API-ROOT-004 GET /api/admin/dataset/reconcile/reports */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const windowValue = firstQueryValue(request.query.window) ?? '';
    const rawScope = firstQueryValue(request.query.scope);
    let scopeValue: unknown = null;
    if (rawScope !== undefined) {
      try {
        scopeValue = JSON.parse(rawScope);
      } catch {
        // 解析失败以 scope:null 触发 ZodError，由 validationErrorCode 映射为 501070。
        scopeValue = null;
      }
    }
    const pageValue = firstQueryValue(request.query.page);
    const page = pageValue === undefined ? 1 : Number(pageValue);
    if (!WINDOW_PATTERN.test(windowValue)) {
      throw invalidQuery(requestId, 'window', windowValue);
    }
    const windowHours = Number(windowValue.slice(0, -1));
    if (windowHours > MAX_WINDOW_HOURS) {
      throw invalidQuery(requestId, 'window', windowValue);
    }
    if (!Number.isInteger(page) || page < 1) {
      throw invalidQuery(requestId, 'page', pageValue);
    }

    const query = parseDto<ReconcileReportsQueryDto>('ReconcileReportsQuery', {
      window: windowValue,
      scope: scopeValue,
      state: firstQueryValue(request.query.state),
      page,
    });
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const result = await runtime.reconcileService.listReports(
      {
        windowHours,
        scope: query.scope ?? null,
        ...(query.state !== undefined ? { state: query.state } : {}),
        page,
      },
      context,
    );
    response
      .status(200)
      .json(successResponse({ total: result.total, list: result.list }, requestId));
  },
  { validationErrorCode: 501070 },
);
