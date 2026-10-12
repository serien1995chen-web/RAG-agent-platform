import { ApiErrorException, createApiError } from '@kb/contracts';
import type { JsonValue } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../runtime/auth';
import { getRuntime } from '../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';
import { verifyUploadToken } from './file/presignUpload';
import { buildImportSource } from './collection/create/file';

interface CreateDatasetWithFilesBody {
  datasetParams: {
    name: string;
    type: 'dataset' | 'folder';
    models: { embeddingModel: string; llmModel?: string; vlmModel?: string; rerankModel?: string };
    parentId?: string;
  };
  files: string[];
}

const MAX_FILES = 10;

/** API-AGG-001 POST /api/core/dataset/createWithFiles */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CreateDatasetWithFilesBody>('CreateDatasetWithFilesBody', request.body);
    if (body.files.length > MAX_FILES) {
      throw new ApiErrorException(
        createApiError({
          code: 501030,
          requestId,
          params: { limit: MAX_FILES, actual: body.files.length },
        }),
      );
    }
    const options = { timeoutMs: 30_000 };
    // 先校验 datasetParams 与全部 file token，再产生任何副作用。
    const payloads = body.files.map((fileId) => verifyUploadToken(fileId, context));
    const dataset = await runtime.datasetApi.createDataset(
      {
        name: body.datasetParams.name,
        type: body.datasetParams.type,
        ...(body.datasetParams.parentId !== undefined
          ? { parentId: body.datasetParams.parentId }
          : {}),
        vectorModel: body.datasetParams.models.embeddingModel,
      },
      context,
    );
    const datasetId = String((dataset as { datasetId?: string }).datasetId ?? '');
    const service = buildImportSource(runtime);
    const createdCollections: string[] = [];
    const collections: JsonValue[] = [];
    try {
      for (const payload of payloads) {
        const result = await service.createCollectionFromSource(
          {
            collection: {
              teamId: context.tenant.teamId,
              datasetId,
              parentId: null,
              type: 'file',
              name: payload.key.split('/').pop() ?? 'file',
              tagIds: [],
              sourceRef: payload.key,
              trainingPolicy: null,
            },
            sourceType: 'file',
            sourceRef: payload.key,
            options,
          },
          context,
        );
        createdCollections.push(result.collectionId);
        collections.push({ collectionId: result.collectionId, insertLen: result.insertLen });
      }
    } catch (error) {
      // 失败不留下半成品 Collection：对本轮已创建集合做树删除，再抛原错误。
      for (const collectionId of createdCollections) {
        await runtime.collectionRepository.deleteTree({ collectionId, options }, context);
      }
      throw error;
    }
    response.status(200).json(successResponse({ datasetId, collections }, requestId));
  },
  { validationErrorCode: 501030 },
);
