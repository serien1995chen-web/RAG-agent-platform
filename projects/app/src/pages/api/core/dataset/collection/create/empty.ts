import type { CollectionSnapshot } from '@kb/service';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../../runtime';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';

function sourceCollection(input: {
  teamId: string;
  datasetId: string;
  name: string;
  sourceRef: string;
  type?: string;
  parentId?: string | null;
}): Omit<CollectionSnapshot, 'collectionId' | 'version' | 'createTime' | 'updateTime'> {
  return {
    teamId: input.teamId,
    datasetId: input.datasetId,
    parentId: input.parentId ?? null,
    type: input.type ?? 'file',
    name: input.name,
    tagIds: [],
    sourceRef: input.sourceRef,
  };
}

const PORT_OPTIONS = { timeoutMs: 10_000 } as const;
function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

interface CollectionCreateEmptyBody {
  datasetId: string;
  parentId?: string;
  name: string;
  type?: 'virtual' | 'file';
}

/** API-COL-017 POST /api/core/dataset/collection/create/empty */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateEmptyBody>('CollectionCreateEmptyBody', request.body);
    if (body.name.length < 1 || body.name.length > 100) {
      throw apiError(501004, requestId, { field: 'name' });
    }
    const type = body.type ?? 'virtual';
    const created = await runtime.collectionRepository.create(
      {
        collection: sourceCollection({
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          parentId: body.parentId ?? null,
          name: body.name,
          type,
          sourceRef: type === 'virtual' ? 'virtual' : 'empty',
        }),
        options: PORT_OPTIONS,
      },
      context,
    );
    response
      .status(200)
      .json(successResponse({ collectionId: created.collectionId, type }, requestId));
  },
  { validationErrorCode: 501004 },
);
