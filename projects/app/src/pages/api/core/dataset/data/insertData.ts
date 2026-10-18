import { randomBytes } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';
import { InsertDataService } from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

interface InsertDataBody {
  collectionId: string;
  q: string;
  a?: string;
}

/** API-DATA-005 POST /api/core/dataset/data/insertData（直接插入，不经 Training Queue） */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<InsertDataBody>('InsertDataBody', request.body);
    const options = { timeoutMs: 15_000 };
    const collection = await runtime.collectionService.getCollection(
      { collectionId: body.collectionId, options },
      context,
    );
    const detail = await runtime.datasetApi.getDatasetDetail(collection.datasetId, context);
    const vectors = await runtime.embeddingService.embed(
      { models: { embeddingModel: detail.dataset.vectorModel }, texts: [body.q], options },
      context,
    );
    const dataId = randomBytes(12).toString('hex');
    const service = new InsertDataService({
      items: runtime.knowledgeItemRepository,
      vectors: runtime.vectorController,
      fullText: runtime.fullTextStore ?? runtime.ports.fullTextStore,
    });
    const result = await service.insertDirect(
      {
        dataId,
        datasetId: collection.datasetId,
        collectionId: body.collectionId,
        q: body.q,
        ...(body.a !== undefined ? { a: body.a } : {}),
        indexVersion: detail.dataset.indexVersion,
        vector: vectors[0] ?? [],
        options,
      },
      context,
    );
    if (result.duplicates > 0) {
      throw new ApiErrorException(
        createApiError({
          code: 501003,
          requestId,
          params: {
            dedupKey: result.dedupKey,
            datasetId: collection.datasetId,
            collectionId: body.collectionId,
          },
        }),
      );
    }
    response.status(200).json(successResponse({ dataId: result.dataId }, requestId));
  },
  // ISSUE-005：参数校验失败走通用输入错误码；501071 仅保留给真实配额超限。
  { validationErrorCode: 501072 },
);
