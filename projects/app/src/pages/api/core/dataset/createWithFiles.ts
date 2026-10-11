import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../runtime';
import { authenticateRequest } from '../../../../runtime/auth';
import { getRuntime } from '../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';
import { PORT_OPTIONS, apiError, sourceCollection } from '../../../../shared/import-source';

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
    if (body.datasetParams.type === 'websiteDataset') {
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