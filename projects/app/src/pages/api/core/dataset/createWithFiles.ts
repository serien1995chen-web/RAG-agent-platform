import type { CollectionSnapshot } from '@kb/service';
import { ApiErrorException, createApiError } from '@kb/contracts';
import { WEBSITE_DATASET_TYPE } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../runtime';
import { authenticateRequest } from '../../../../runtime/auth';
import { getRuntime } from '../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';

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

interface CreateDatasetWithFilesBody {
  datasetParams: {
    name: string;
    type: string;
    parentId?: string;
    models?: { embeddingModel?: string };
  };
  files: string[];
}

/** API-AGG-001 POST /api/core/dataset/createWithFiles */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CreateDatasetWithFilesBody>('CreateDatasetWithFilesBody', request.body);
    if (body.datasetParams.type === WEBSITE_DATASET_TYPE) {
      throw apiError(501001, requestId, { field: 'type' });
    }
    if (body.files.length > 10) {
      throw apiError(501030, requestId, { limit: 10, actual: body.files.length });
    }
    const dataset = await runtime.datasetApi.createDataset(
      {
        name: body.datasetParams.name,
        type: 'dataset',
        ...(body.datasetParams.parentId !== undefined
          ? { parentId: body.datasetParams.parentId }
          : {}),
        vectorModel: body.datasetParams.models?.embeddingModel ?? 'bge-m3',
      },
      context,
    );
    const collections: Array<{ fileId: string; collectionId: string }> = [];
    for (const fileId of body.files) {
      const created = await runtime.collectionRepository.create(
        {
          collection: sourceCollection({
            teamId: context.tenant.teamId,
            datasetId: dataset.datasetId,
            name: fileId,
            sourceRef: fileId,
          }),
          options: PORT_OPTIONS,
        },
        context,
      );
      collections.push({ fileId, collectionId: created.collectionId });
    }
    response
      .status(200)
      .json(successResponse({ datasetId: dataset.datasetId, collections }, requestId));
  },
  { validationErrorCode: 501030 },
);
