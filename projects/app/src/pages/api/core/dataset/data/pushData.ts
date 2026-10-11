import { PushDataService } from '@kb/service';
import type { QueuePort } from '@kb/dal';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';
import { PORT_OPTIONS, apiError } from '../../../../../shared/import-source';

interface PushDataBody {
  data: Array<{ collectionId: string; q: string; a?: string }>;
}

const MAX_PUSH_BYTES = 10 * 1024 * 1024;

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
    const firstCollection = body.data[0]!.collectionId;
    const collection = await runtime.collectionService.getCollection(
      { collectionId: firstCollection, options: PORT_OPTIONS },
      context,
    );
    const queue = (runtime.ports as { queue?: QueuePort }).queue;
    if (!queue) throw apiError(501062, requestId, { dependency: 'queue', mode: 'parse' });
    const service = new PushDataService({
      jobs: runtime.processingRepository,
      trainingProcessor: runtime.ports.trainingProcessor,
      queue,
      maxItems,
      maxBytes: MAX_PUSH_BYTES,
    });
    const result = await service.pushBatch(
      {
        datasetId: collection.datasetId,
        collectionId: collection.collectionId,
        mode: 'qa',
        items: body.data.map((item, index) => ({
          dataId: `push-${index}-${Date.now().toString(36)}`,
          version: 1,
          payload: item,
        })),
        options: PORT_OPTIONS,
      },
      context,
    );
    response.status(200).json(successResponse({ queued: result }, requestId));
  },
  { validationErrorCode: 501030 },
);
