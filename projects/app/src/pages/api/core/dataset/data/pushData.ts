import { createHash } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';
import { PushDataService } from '@kb/service';
import type { QueuePort } from '@kb/dal';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime/health';
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

interface PushDataBody {
  data: Array<{ collectionId: string; q: string; a?: string }>;
}

const MAX_PUSH_BYTES = 10 * 1024 * 1024;

/** 稳定幂等键：同一 collection + 同一 q/a 内容恒定，重复 push 不重复 Data/Training/账单。 */
function stableDataId(collectionId: string, q: string, a: string): string {
  const digest = createHash('sha256').update(`${collectionId}\u0000${q}\u0000${a}`).digest('hex');
  return `qa-${digest.slice(0, 32)}`;
}

/** API-DATA-007 POST /api/core/dataset/data/pushData */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<PushDataBody>('PushDataBody', request.body);
    const maxItems = runtime.config.datasetRuntime.maxPushItems;
    if (body.data.length > maxItems) {
      throw apiError(501030, requestId, { limit: maxItems, actual: body.data.length });
    }
    const bytes = Buffer.byteLength(JSON.stringify(body.data), 'utf8');
    if (bytes > MAX_PUSH_BYTES) {
      throw apiError(501065, requestId, { limitBytes: MAX_PUSH_BYTES, actualBytes: bytes });
    }
    if (body.data.length === 0) {
      response
        .status(200)
        .json(successResponse({ queued: { accepted: 0, skipped: 0, taskIds: [] } }, requestId));
      return;
    }
    // 按 collectionId 分组，逐组校验归属与同一 dataset，避免只用首条 collection。
    const byCollection = new Map<string, PushDataBody['data']>();
    for (const item of body.data) {
      const bucket = byCollection.get(item.collectionId) ?? [];
      bucket.push(item);
      byCollection.set(item.collectionId, bucket);
    }
    const queue = (runtime.ports as { queue?: QueuePort }).queue;
    if (!queue) throw apiError(501062, requestId, { dependency: 'queue', mode: 'parse' });
    const service = new PushDataService({
      jobs: runtime.processingRepository,
      trainingProcessor: runtime.ports.trainingProcessor,
      queue,
      maxItems,
      maxBytes: MAX_PUSH_BYTES,
    });
    let accepted = 0;
    let skipped = 0;
    const taskIds: string[] = [];
    for (const [collectionId, items] of byCollection) {
      const collection = await runtime.collectionService.getCollection(
        { collectionId, options: PORT_OPTIONS },
        context,
      );
      if (collection.teamId !== context.tenant.teamId) {
        throw apiError(501061, requestId, { collectionId });
      }
      const result = await service.pushBatch(
        {
          datasetId: collection.datasetId,
          collectionId: collection.collectionId,
          mode: 'qa',
          items: items.map((item) => ({
            dataId: stableDataId(collection.collectionId, item.q, item.a ?? ''),
            version: 1,
            payload: item,
          })),
          options: PORT_OPTIONS,
        },
        context,
      );
      accepted += result.accepted;
      skipped += result.skipped;
      taskIds.push(...result.taskIds);
    }
    response
      .status(200)
      .json(successResponse({ queued: { accepted, skipped, taskIds } }, requestId));
  },
  { validationErrorCode: 501030 },
);
