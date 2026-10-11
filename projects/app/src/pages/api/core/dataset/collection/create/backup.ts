import type { CollectionSnapshot } from '@kb/service';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../../runtime';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime/health';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';

function sourceCollection(input: {
  teamId: string;
  datasetId: string;
  name: string;
  sourceRef: string;
  type?: string;
  parentId?: string | null;
}): Omit<CollectionSnapshot, 'collectionId' | 'version' | 'createTime' | 'updateTime'> {
  return {
    teamId: input.teamId,
    datasetId: input.datasetId,
    parentId: input.parentId ?? null,
    type: input.type ?? 'file',
    name: input.name,
    tagIds: [],
    sourceRef: input.sourceRef,
  };
}

const PORT_OPTIONS = { timeoutMs: 10_000 } as const;
function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

interface CollectionCreateBackupForm {
  file?: unknown;
  datasetId: string;
  parentId?: string;
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

/** 真实 CSV/XLSX 表头校验 + 行数统计：表头需含 q/a 且无重复，返回真实 insertLen。 */
function parseBackup(bytes: Buffer, name: string): { insertLen: number } {
  const lower = name.toLowerCase();
  if (lower.endsWith('.xlsx')) {
    // XLSX 为二进制容器；此处不臆造解析，交由上游 parser 能力，缺失时稳定拒绝。
    throw apiError(501056, 'backup', { format: 'xlsx' });
  }
  const rows = bytes
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (rows.length === 0) return { insertLen: 0 };
  const header = (rows.shift() ?? '').split(',').map((value) => value.trim().toLowerCase());
  const hasQ = header.includes('q');
  const hasA = header.includes('a');
  const duplicate = new Set(header).size !== header.length;
  if (!hasQ || !hasA) {
    throw apiError(501058, 'backup', { missingHeaders: ['q', 'a'], duplicateHeaders: [] });
  }
  if (duplicate) throw apiError(501059, 'backup', { sheet: 'sheet1' });
  return { insertLen: rows.length };
}

/** API-COL-009 POST /api/core/dataset/collection/create/backup */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateBackupForm>('CollectionCreateBackupForm', request.body);
    const bytes = toBytes(body.file);
    if (bytes === null) {
      throw apiError(501058, requestId, { missingHeaders: ['q', 'a'], duplicateHeaders: [] });
    }
    const name =
      body.file && typeof body.file === 'object' && 'name' in body.file
        ? String((body.file as { name?: unknown }).name ?? 'backup.csv')
        : 'backup.csv';
    const { insertLen } = parseBackup(bytes, name);
    const created = await runtime.collectionRepository.create(
      {
        collection: sourceCollection({
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          parentId: body.parentId ?? null,
          name: 'backup',
          sourceRef: name,
        }),
        options: PORT_OPTIONS,
      },
      context,
    );
    response
      .status(200)
      .json(successResponse({ collectionId: created.collectionId, insertLen }, requestId));
  },
  { validationErrorCode: 501059 },
);
