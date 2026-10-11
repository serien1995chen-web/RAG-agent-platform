import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../runtime/auth';
import { getRuntime } from '../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_IMPORT_ROWS = 10000;

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

interface ImportReportValue {
  success: number;
  skipped: number;
  failed: number;
  errors: Array<{ row: number; code: string; messageKey: string; params: Record<string, unknown> }>;
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

function parseRows(bytes: Buffer, name: string): Array<{ q: string; a: string }> {
  const text = bytes.toString('utf8').trim();
  if (text.length === 0) return [];
  const lower = name.toLowerCase();
  if (lower.endsWith('.jsonl')) {
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const value = JSON.parse(line) as { q?: string; a?: string };
        return { q: String(value.q ?? ''), a: String(value.a ?? '') };
      });
  }
  if (lower.endsWith('.csv')) {
    const rows = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const header = (rows.shift() ?? '').split(',').map((value) => value.trim().toLowerCase());
    const qIndex = header.indexOf('q');
    const aIndex = header.indexOf('a');
    if (qIndex === -1 || aIndex === -1) {
      throw apiError(501058, 'import', { missingHeaders: ['q', 'a'], duplicateHeaders: [] });
    }
    return rows.map((line) => {
      const cells = line.split(',');
      return { q: (cells[qIndex] ?? '').trim(), a: (cells[aIndex] ?? '').trim() };
    });
  }
  throw apiError(501056, 'import', { format: name.split('.').pop() ?? 'unknown' });
}

/** API-IMP-002 POST /api/core/dataset/import */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    await authenticateRequest(runtime, request, requestId);
    const body = parseDto<DatasetImportForm>('DatasetImportForm', request.body);
    if (body.targetCollectionId !== undefined && body.datasetId.length === 0) {
      throw apiError(501061, requestId, {});
    }
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
    const name =
      body.file && typeof body.file === 'object' && 'name' in body.file
        ? String((body.file as { name?: unknown }).name ?? 'import.jsonl')
        : 'import.jsonl';
    const rows = parseRows(bytes, name);
    if (rows.length > MAX_IMPORT_ROWS) {
      throw apiError(501030, requestId, { limitRows: MAX_IMPORT_ROWS, actualRows: rows.length });
    }
    const seen = new Set<string>();
    const report: ImportReportValue = { success: 0, skipped: 0, failed: 0, errors: [] };
    rows.forEach((row, index) => {
      if (row.q.trim().length === 0) {
        report.failed += 1;
        if (report.errors.length < 100) {
          report.errors.push({
            row: index,
            code: 'empty_question',
            messageKey: 'dataset.import.empty_question',
            params: {},
          });
        }
        return;
      }
      const key = `${row.q}\u0000${row.a}`;
      if (seen.has(key)) {
        report.skipped += 1;
        return;
      }
      seen.add(key);
      report.success += 1;
    });
    response.status(200).json(successResponse({ report }, requestId));
  },
  { validationErrorCode: 501030 },
);
