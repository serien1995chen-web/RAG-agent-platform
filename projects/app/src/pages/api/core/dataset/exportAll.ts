import { deflateRawSync } from 'node:zlib';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../runtime';
import { authenticateRequest } from '../../../../runtime/auth';
import { getRuntime } from '../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';

interface DatasetExportQuery {
  datasetId: string;
  format?: 'jsonl' | 'zip';
}

interface ExportRow {
  collectionId: string;
  dataId: string;
  q: string;
  a?: string;
}

function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

function toJsonl(rows: ExportRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n');
}

/** 生成单文件真实 ZIP 归档（无外部依赖）：local header + deflate + central directory + EOCD。 */
function buildZip(fileName: string, content: Buffer): Buffer {
  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();
  let crc = 0xffffffff;
  for (const byte of content) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  const nameBytes = Buffer.from(fileName, 'utf8');
  const compressed = deflateRawSync(content);
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(nameBytes.length, 26);
  localHeader.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  const centralOffset = localHeader.length + nameBytes.length + compressed.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBytes.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localHeader, nameBytes, compressed, central, nameBytes, eocd]);
}

/** API-EXP-001 GET /api/core/dataset/exportAll */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<DatasetExportQuery>('DatasetExportQuery', request.query);
    const detail = await runtime.datasetApi.getDatasetDetail(query.datasetId, context);
    if (detail.dataset.teamId !== context.tenant.teamId) {
      throw apiError(501027, requestId, { requiredRole: 'read' });
    }
    const collections = await runtime.collectionRepository.list(
      { datasetId: query.datasetId, page: 1, limit: 1000, options: { timeoutMs: 10_000 } },
      context,
    );
    const rows: ExportRow[] = [];
    for (const collection of collections.list) {
      const items = await runtime.knowledgeItemService.listItems(
        {
          collectionId: collection.collectionId,
          page: 1,
          limit: 1000,
          options: { timeoutMs: 10_000 },
        },
        context,
      );
      for (const item of items.list) {
        rows.push({
          collectionId: collection.collectionId,
          dataId: item.dataId,
          q: item.q ?? '',
          ...(item.a !== undefined ? { a: item.a } : {}),
        });
      }
    }
    const jsonl = toJsonl(rows);
    const format = query.format ?? 'zip';
    const bytes =
      format === 'zip'
        ? buildZip('dataset.jsonl', Buffer.from(jsonl, 'utf8'))
        : Buffer.from(jsonl, 'utf8');
    response.status(200).json(
      successResponse(
        {
          contentType: format === 'zip' ? 'application/zip' : 'application/x-ndjson',
          body: bytes.toString('base64'),
        },
        requestId,
      ),
    );
  },
  { validationErrorCode: 501070 },
);
