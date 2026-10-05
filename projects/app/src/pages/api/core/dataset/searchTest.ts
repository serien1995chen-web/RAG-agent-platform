import { ApiErrorException, createApiError } from '@kb/contracts';
import type { SearchRequest } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../runtime/auth';
import { getRuntime } from '../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';

interface SearchTestBody {
  datasetId: string;
  text?: string;
  queryImageUrls?: string[];
  searchMode?: 'embedding' | 'fullTextRecall' | 'mixedRecall';
  limit?: number;
  similarity?: number;
  usingReRank?: boolean;
  embeddingWeight?: number;
  rerankWeight?: number;
  collectionFilterMatch?: string;
}

/** API-SEARCH-001 POST /api/core/dataset/searchTest */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<SearchTestBody>('SearchTestBody', request.body);
    const hasText = typeof body.text === 'string' && body.text.trim().length > 0;
    const imageQueries = (body.queryImageUrls ?? []).map((url) => ({ url }));
    if (!hasText && imageQueries.length === 0) {
      throw new ApiErrorException(
        createApiError({
          code: 501049,
          requestId,
          params: { allowed: ['text', 'queryImageUrls'] },
        }),
      );
    }
    const detail = await runtime.datasetApi.getDatasetDetail(body.datasetId, context);
    const searchRequest: SearchRequest = {
      requestId,
      teamId: context.tenant.teamId,
      tmbId: context.tenant.tmbId,
      datasetIds: [body.datasetId],
      textQueries: hasText ? [body.text!] : [],
      imageQueries,
      models: { embeddingModel: detail.dataset.vectorModel },
      searchMode: body.searchMode ?? 'embedding',
      limit: body.limit ?? 10,
      maxTokens: 4000,
      similarity: body.similarity ?? 0,
      ...(body.embeddingWeight !== undefined || body.rerankWeight !== undefined
        ? {
            weights: {
              embedding: body.embeddingWeight ?? 0.5,
              rerank: body.rerankWeight ?? 0.5,
            },
          }
        : {}),
    };
    const result = await runtime.datasetSearch.search(searchRequest, context);
    response
      .status(200)
      .json(
        successResponse(
          { searchRes: result, usingSimilarityFilter: result.stats.usingSimilarityFilter },
          requestId,
        ),
      );
  },
  { validationErrorCode: 501050 },
);
