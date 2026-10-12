import { createHash } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';
import { PushDataService } from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { resolveQueue } from '../collection/create/file';

interface PushDataBody {
  data: { collectionId: string; q: string; a?: string }[];
}

const DEFAULT_MAX_ITEMS = 200;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function stableDataId(collectionId: string, index: number, q: string, a: string): string {
  return createHash('sha256')
    .update(`${collectionId}:${index}:${q}:${a}`)
    .digest('hex')
    .slice(0, 24);
}

/** API-DATA-007 POST /api/core/dataset/data/pushData（先校验 200 条 / 10MB，再副作用） */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<PushDataBody>('PushDataBody', request.body);
    const limits =
      (runtime.config as { datasetRuntime?: { maxPushItems: number; maxRequestBodyBytes: number } })
        .datasetRuntime ?? undefined;
    const maxItems = limits?.maxPushItems ?? DEFAULT_MAX_ITEMS;
    const maxBytes = limits?.maxRequestBodyBytes ?? DEFAULT_MAX_BYTES;
    if (body.data.length > maxItems) {
      throw new ApiErrorException(
        createApiError({
          code: 501030,
          requestId,
          params: { limit: maxItems, actual: body.data.length },
        }),
      );
    }
    const bytes = Buffer.byteLength(JSON.stringify(body.data), 'utf8');
    if (bytes > maxBytes) {
      throw new ApiErrorException(
        createApiError({
          code: 501065,
          requestId,
          params: { limitBytes: maxBytes, actualBytes: bytes, urlHash: '' },
        }),
      );
    }
    const first = body.data[0];
    if (!first) {
      response
        .status(200)
        .json(successResponse({ queued: { accepted: 0, skipped: 0, taskIds: [] } }, requestId));
      return;
    }
    const options = { timeoutMs: 15_000 };
    const collection = await runtime.collectionService.getCollection(
      { collectionId: first.collectionId, options },
      context,
    );
    const service = new PushDataService({
      jobs: runtime.processingRepository,
      trainingProcessor: runtime.ports.trainingProcessor,
      queue: resolveQueue(runtime),
    });
    const items = body.data.map((item, index) => ({
      dataId: stableDataId(first.collectionId, index, item.q, item.a ?? ''),
      version: 1,
      payload: item,
    }));
    const result = await service.pushBatch(
      {
        datasetId: collection.datasetId,
        collectionId: first.collectionId,
        mode: 'qa',
        items,
        options,
      },
      context,
    );
    response.status(200).json(successResponse({ queued: result }, requestId));
  },
  { validationErrorCode: 501030 },
);
