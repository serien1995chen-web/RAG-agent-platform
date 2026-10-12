import { crc32 } from 'node:zlib';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { RequestContext } from '@kb/service';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../runtime';
import { authenticateRequest } from '../../../../runtime/auth';
import { getRuntime } from '../../../../runtime';
import { parseDto, withApiHandler } from '../../../../shared/api';
import type { ApiHandlerContext } from '../../../../shared/api';

interface DatasetExportQuery {
  datasetId: string;
  format?: 'jsonl' | 'zip';
}

interface ExportRecord {
  collectionId: string;
  dataId: string;
  q: string;
  a: string;
  indexes: { indexId: string; type: string; text: string }[];
  metadata: unknown;
}

const MAX_EXPORT_BYTES = 1024 * 1024 * 1024;
const PAGE_SIZE = 100;
const ITEM_PAGE_SIZE = 200;
const OPTIONS = { timeoutMs: 5_000 };
const ZIP_NAME = 'export.jsonl';

function lineOf(record: ExportRecord): string {
  return JSON.stringify(record) + '\n';
}

/** 只读快照遍历：按 page 完整翻页，不聚合整份记录到内存。visit 返回 false 提前停止。 */
async function forEachRecord(
  runtime: ExtendedAppRuntime,
  datasetId: string,
  context: RequestContext,
  visit: (record: ExportRecord) => boolean | void,
): Promise<void> {
  for (let page = 1; ; page += 1) {
    const collections = await runtime.collectionRepository.list(
      { datasetId, page, limit: PAGE_SIZE, options: OPTIONS },
      context,
    );
    if (collections.list.length === 0) break;
    for (const collection of collections.list) {
      for (let itemPage = 1; ; itemPage += 1) {
        const items = await runtime.knowledgeItemService.listItems(
          {
            collectionId: collection.collectionId,
            page: itemPage,
            limit: ITEM_PAGE_SIZE,
            options: OPTIONS,
          },
          context,
        );
        if (items.list.length === 0) break;
        for (const item of items.list) {
          const stop = visit({
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
          });
          if (stop === false) return;
        }
        if (items.list.length < ITEM_PAGE_SIZE) break;
      }
    }
    if (collections.list.length < PAGE_SIZE) break;
  }
}

/** API-EXP-001 GET /api/core/dataset/exportAll（服务端游标流式；1GB 上限在流前判定） */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const query = parseDto<DatasetExportQuery>('DatasetExportQuery', request.query);

    // 预计数 pass：不保留正文，超出 1GB 时在写响应前返回 501030。
    let totalBytes = 0;
    let exceeded = false;
    await forEachRecord(runtime, query.datasetId, context, (record) => {
      totalBytes += Buffer.byteLength(lineOf(record), 'utf8');
      if (totalBytes > MAX_EXPORT_BYTES) {
        exceeded = true;
        return false;
      }
      return true;
    });
    if (exceeded) {
      throw new ApiErrorException(
        createApiError({
          code: 501030,
          requestId,
          params: { limit: MAX_EXPORT_BYTES, actual: totalBytes },
        }),
      );
    }

    response.status(200);
    if (query.format === 'jsonl') {
      response.setHeader('content-type', 'application/x-ndjson');
      await forEachRecord(runtime, query.datasetId, context, (record) => {
        response.write(lineOf(record));
        return true;
      });
      response.end();
      return;
    }
    await writeZipStream(response, runtime, query.datasetId, context);
  },
  { validationErrorCode: 501070 },
);

/** 单文件 store ZIP（data descriptor + bit 3）：边写边算 CRC，不在内存驻留整份导出。 */
async function writeZipStream(
  response: NextApiResponse,
  runtime: ExtendedAppRuntime,
  datasetId: string,
  context: RequestContext,
): Promise<void> {
  const nameBuf = Buffer.from(ZIP_NAME, 'utf8');
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0008, 6); // data descriptor
  local.writeUInt16LE(0, 8); // store
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);
  response.setHeader('content-type', 'application/zip');
  response.write(local);

  let crc = 0;
  let size = 0;
  await forEachRecord(runtime, datasetId, context, (record) => {
    const chunk = Buffer.from(lineOf(record), 'utf8');
    crc = crc32(chunk, crc) >>> 0;
    size += chunk.length;
    response.write(chunk);
    return true;
  });
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(size, 8);
  descriptor.writeUInt32LE(size, 12);
  response.write(descriptor);

  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0008, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(size, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  nameBuf.copy(central, 46);
  response.write(central);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  response.write(eocd);
  response.end();
}
