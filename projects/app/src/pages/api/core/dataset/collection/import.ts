import { createHash } from 'node:crypto';
import { PushDataService } from '@kb/service';
import type { QueuePort } from '@kb/dal';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

const PORT_OPTIONS = { timeoutMs: 10_000 } as const;
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

interface DatasetImportForm {
  file?: unknown;
  datasetId: string;
  targetCollectionId?: string;
  mapping?: unknown;
}

function toBytes(file: unknown): Buffer | null {
  if (typeof file === 'string') return Buffer.from(file, 'base64');
  if (file instanceof Uint8Array) return Buffer.from(file);
  if (file && typeof file === 'object' && 'data' in file) {
    const data = (file as { data?: unknown }).data;
    if (typeof data === 'string') return Buffer.from(data, 'base64');
    if (data instanceof Uint8Array) return Buffer.from(data);
  }
  return null;
}

function stableImportDataId(collectionId: string, q: string, a: string): string {
  const digest = createHash('sha256').update(`${collectionId}\u0000${q}\u0000${a}`).digest('hex');
  return `imp-${digest.slice(0, 32)}`;
}

/** API-IMP-001 POST /api/core/dataset/collection/import */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<DatasetImportForm>('DatasetImportForm', request.body);
    const bytes = toBytes(body.file);
    if (bytes === null) {
      throw apiError(501058, requestId, { missingHeaders: ['q'], duplicateHeaders: [] });
    }
    if (bytes.byteLength > MAX_IMPORT_BYTES) {
      throw apiError(501030, requestId, {
        limitBytes: MAX_IMPORT_BYTES,
        actualBytes: bytes.byteLength,
      });
    }
    const text = bytes.toString('utf8').trim();
    const lines = text.length === 0 ? [] : text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const seen = new Set<string>();
    const validRows: Array<{ q: string; a: string }> = [];
    let skipped = 0;
    let failed = 0;
    for (const line of lines) {
      if (seen.has(line)) {
        skipped += 1;
        continue;
      }
      seen.add(line);
      try {
        const parsed = JSON.parse(line) as { q?: string; a?: string };
        if (!parsed.q || parsed.q.trim().length === 0) throw new Error('empty-q');
        validRows.push({ q: String(parsed.q), a: String(parsed.a ?? '') });
      } catch {
        failed += 1;
      }
    }
    // 真实持久化：有效行经 PushDataService 生成真实 qa 任务。
    const collectionId = body.targetCollectionId;
    if (validRows.length > 0 && !collectionId) {
      throw apiError(501004, requestId, { field: 'targetCollectionId' });
    }
    const queue = (runtime.ports as { queue?: QueuePort }).queue;
    if (validRows.length > 0 && !queue) {
      throw apiError(501062, requestId, { dependency: 'queue', mode: 'qa' });
    }
    let success = 0;
    if (validRows.length > 0 && queue && collectionId) {
      const collection = await runtime.collectionService.getCollection(
        { collectionId, options: PORT_OPTIONS },
        context,
      );
      const service = new PushDataService({
        jobs: runtime.processingRepository,
        trainingProcessor: runtime.ports.trainingProcessor,
        queue,
      });
      const result = await service.pushBatch(
        {
          datasetId: collection.datasetId,
          collectionId: collection.collectionId,
          mode: 'qa',
          items: validRows.map((row) => ({
            dataId: stableImportDataId(collection.collectionId, row.q, row.a),
            version: 1,
            payload: row,
          })),
          options: PORT_OPTIONS,
        },
        context,
      );
      success = result.accepted;
    }
    response
      .status(200)
      .json(successResponse({ report: { success, skipped, failed, errors: [] } }, requestId));
  },
  { validationErrorCode: 501059 },
);
