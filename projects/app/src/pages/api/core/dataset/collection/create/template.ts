import type { CollectionSnapshot } from '@kb/service';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ExtendedAppRuntime } from '../../../../../../runtime';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime';
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

interface CollectionCreateTemplateForm {
  file?: unknown;
  datasetId: string;
  templateId: string;
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

/** 真实模板文件解析：CSV 表头需含 q/a 且无重复，返回真实 insertLen。 */
function parseTemplate(bytes: Buffer, name: string): { insertLen: number } {
  if (name.toLowerCase().endsWith('.xlsx')) {
    throw apiError(501056, 'template', { format: 'xlsx' });
  }
  const rows = bytes
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (rows.length === 0) return { insertLen: 0 };
  const header = (rows.shift() ?? '').split(',').map((value) => value.trim().toLowerCase());
  const ok = header.includes('q') && header.includes('a');
  const duplicate = new Set(header).size !== header.length;
  if (!ok) {
    throw apiError(501058, 'template', { missingHeaders: ['q', 'a'], duplicateHeaders: [] });
  }
  if (duplicate) throw apiError(501059, 'template', { sheet: 'sheet1' });
  return { insertLen: rows.length };
}

/** API-COL-010 POST /api/core/dataset/collection/create/template */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<CollectionCreateTemplateForm>(
      'CollectionCreateTemplateForm',
      request.body,
    );
    if (typeof body.templateId !== 'string' || body.templateId.length === 0) {
      throw apiError(501037, requestId, { templateId: '' });
    }
    const bytes = toBytes(body.file);
    if (bytes === null) {
      throw apiError(501037, requestId, { templateId: body.templateId });
    }
    const name =
      body.file && typeof body.file === 'object' && 'name' in body.file
        ? String((body.file as { name?: unknown }).name ?? 'template.csv')
        : 'template.csv';
    const { insertLen } = parseTemplate(bytes, name);
    const created = await runtime.collectionRepository.create(
      {
        collection: sourceCollection({
          teamId: context.tenant.teamId,
          datasetId: body.datasetId,
          name: body.templateId,
          sourceRef: body.templateId,
        }),
        options: PORT_OPTIONS,
      },
      context,
    );
    response
      .status(200)
      .json(successResponse({ collectionId: created.collectionId, insertLen }, requestId));
  },
  { validationErrorCode: 501030 },
);
