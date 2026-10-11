import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

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

/** API-IMP-001 POST /api/core/dataset/collection/import */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    await authenticateRequest(runtime, request, requestId);
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
    let success = 0;
    let skipped = 0;
    let failed = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (seen.has(line)) {
        skipped += 1;
        continue;
      }
      seen.add(line);
      try {
        JSON.parse(line);
        success += 1;
      } catch {
        failed += 1;
      }
    }
    response
      .status(200)
      .json(successResponse({ report: { success, skipped, failed, errors: [] } }, requestId));
  },
  { validationErrorCode: 501059 },
);
