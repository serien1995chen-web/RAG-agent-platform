import { crc32 } from 'node:zlib';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../runtime/auth';
import { getRuntime } from '../../../../runtime';
import { parseDto, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';

interface DatasetExportQuery {
  datasetId: string;
  format?: 'jsonl' | 'zip';
}

const MAX_EXPORT_BYTES = 1024 * 1024 * 1024;

/** 单文件 store（无压缩）ZIP，仅依赖 node:zlib，不引入第三方 zip 库。 */
function buildStoreZip(name: string, data: Buffer): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data) >>> 0;
  const size = data.length;
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(size, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);
  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(size, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  nameBuf.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, data, central, eocd]);
}

function recordOf(item: {
  collectionId: string;
  dataId: string;
  q?: string;
  a?: string;
  indexes?: { indexId: string; type: string; text: string }[];
  metadata?: unknown;
}): Record<string, unknown> {
  return {
    collectionId: item.collectionId,
    dataId: item.dataId,
    q: item.q ?? '',
    a: item.a ?? '',
    indexes: (item.indexes ?? []).map((index) => ({
      indexId: index.indexId,
      type: index.type,
      text: index.text,
    })),
    metadata: item.metadata ?? null,
  };
}

/** API-EXP-001 GET /api/core/dataset/exportAll */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<DatasetExportQuery>('DatasetExportQuery', request.query);
    const records: Record<string, unknown>[] = [];
    for (let page = 1; ; page += 1) {
      const collections = await runtime.collectionRepository.list(
        { datasetId: query.datasetId, page, limit: 100, options: { timeoutMs: 5_000 } },
        context,
      );
      for (const collection of collections.list) {
        const items = await runtime.knowledgeItemService.listItems(
          {
            collectionId: collection.collectionId,
            page: 1,
            limit: 1000,
            options: { timeoutMs: 5_000 },
          },
          context,
        );
        for (const item of items.list) records.push(recordOf(item));
      }
      if (!collections.cursor || collections.list.length === 0) break;
    }
    const jsonl = records.length > 0 ? records.map((r) => JSON.stringify(r)).join('\n') + '\n' : '';
    const size = Buffer.byteLength(jsonl, 'utf8');
    if (size > MAX_EXPORT_BYTES) {
      throw new ApiErrorException(
        createApiError({
          code: 501030,
          requestId,
          params: { limit: MAX_EXPORT_BYTES, actual: size },
        }),
      );
    }
    response.status(200);
    if (query.format === 'jsonl') {
      response.setHeader('content-type', 'application/x-ndjson');
      response.send(jsonl);
      return;
    }
    response.setHeader('content-type', 'application/zip');
    response.send(buildStoreZip('export.jsonl', Buffer.from(jsonl, 'utf8')));
  },
  { validationErrorCode: 501070 },
);
