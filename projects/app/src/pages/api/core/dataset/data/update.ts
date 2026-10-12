import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface DataUpdateBody {
  dataId: string;
  version: number;
  q?: string;
  a?: string;
  indexes?: { indexId: string; text: string; version: number }[];
}

/** API-DATA-003 POST /api/core/dataset/data/update（先写新向量再 CAS 切换引用） */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<DataUpdateBody>('DataUpdateBody', request.body);
    const options = { timeoutMs: 15_000 };
    const item = await runtime.knowledgeItemService.getItem(
      { dataId: body.dataId, options },
      context,
    );
    if (!item) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId,
          params: { resourceType: 'data', resourceId: body.dataId },
        }),
      );
    }
    const text = body.q ?? item.q ?? '';
    const vectors = await runtime.embeddingService.embed(
      { models: { embeddingModel: 'bge-m3' }, texts: [text], options },
      context,
    );
    const indexId = `${body.dataId}:qa`;
    await runtime.vectorController.insert(
      {
        records: [
          {
            teamId: context.tenant.teamId,
            datasetId: item.datasetId,
            collectionId: item.collectionId,
            dataId: body.dataId,
            indexId,
            indexVersion: String(body.version + 1),
            vector: vectors[0] ?? [],
          },
        ],
        options,
      },
      context,
    );
    const indexes = body.indexes
      ? body.indexes.map((index) => ({
          indexId: index.indexId,
          type: 'custom',
          dataId: body.dataId,
          text: index.text,
        }))
      : item.indexes;
    const updated = await runtime.knowledgeItemRepository.updateIndexes(
      { dataId: body.dataId, version: body.version, indexes, options },
      context,
    );
    response
      .status(200)
      .json(successResponse({ dataId: body.dataId, version: updated.version }, requestId));
  },
  { validationErrorCode: 501067 },
);
