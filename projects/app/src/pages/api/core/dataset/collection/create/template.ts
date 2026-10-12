import { ApiErrorException, createApiError } from '@kb/contracts';
import { createDefaultDocumentParser, type DocumentParseContext } from '@kb/parse';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';
import { readMultipartForm } from '../../file/presignUpload';
import { buildImportSource } from './file';

export const config = { api: { bodyParser: false } };

const MAX_DATA_ROWS = 10000;

interface TemplateFields {
  file: Uint8Array;
  datasetId: string;
  templateId: string;
}

function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,12})$/.exec(filename);
  return (match?.[1] ?? '').toLowerCase();
}

function fail(code: number, requestId: string, params: Record<string, unknown>): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

function templateMissing(requestId: string): ApiErrorException {
  return fail(501037, requestId, { templateId: '' });
}

function cellsOf(line: string): string[] {
  return line
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

function markdownTable(text: string): { header: string[]; rows: string[][] } {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'));
  if (lines.length === 0) return { header: [], rows: [] };
  const rows: string[][] = [];
  for (const line of lines.slice(1)) {
    if (/^\|[\s\-:|]+\|$/.test(line)) continue;
    rows.push(cellsOf(line));
  }
  return { header: cellsOf(lines[0] ?? ''), rows };
}

/** API-COL-010 POST /api/core/dataset/collection/create/template */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const form = await readMultipartForm(request);
    const filePart = form.files.file;
    if (!filePart || filePart.content.byteLength === 0) throw templateMissing(requestId);
    const extension = extensionOf(filePart.filename);
    if (extension !== 'csv' && extension !== 'xlsx') {
      throw fail(501056, requestId, { extension: extension || 'unknown' });
    }
    const fields = parseDto<TemplateFields>('CollectionCreateTemplateForm', {
      file: filePart.content,
      datasetId: form.fields.datasetId,
      templateId: form.fields.templateId,
    });
    if (!fields.templateId) throw templateMissing(requestId);
    const parseRequest: DocumentParseContext = {
      teamId: context.tenant.teamId,
      datasetId: fields.datasetId,
      fileRef: filePart.filename,
      extension,
      timeoutMs: 60_000,
      bytes: filePart.content,
    };
    const parsed = await createDefaultDocumentParser()
      .parse(parseRequest)
      .catch(() => null);
    if (!parsed) throw templateMissing(requestId);
    if (extension === 'xlsx' && (parsed.rawText.match(/^## /gm) ?? []).length > 1) {
      throw fail(501059, requestId, { sheetName: '', reason: 'multiple_sheets', limit: 1 });
    }
    const { header, rows } = markdownTable(parsed.rawText);
    if (header.length === 0) {
      throw fail(501059, requestId, { sheetName: '', reason: 'empty_sheet', limit: 1 });
    }
    const normalized = header.map((name) => name.toLowerCase());
    const seen = new Set<string>();
    const duplicateHeaders: string[] = [];
    for (const name of normalized) {
      if (name.length === 0) continue;
      if (seen.has(name)) {
        if (!duplicateHeaders.includes(name)) duplicateHeaders.push(name);
      } else seen.add(name);
    }
    const missingHeaders: string[] = [];
    if (!normalized.includes('q')) missingHeaders.push('q');
    if (!normalized.includes('a')) missingHeaders.push('a');
    if (missingHeaders.length > 0 || duplicateHeaders.length > 0) {
      throw fail(501058, requestId, { missingHeaders, duplicateHeaders });
    }
    if (rows.length > MAX_DATA_ROWS) {
      throw fail(501030, requestId, { limit: MAX_DATA_ROWS, actual: rows.length });
    }
    const service = buildImportSource(runtime);
    const result = await service.createCollectionFromSource(
      {
        collection: {
          teamId: context.tenant.teamId,
          datasetId: fields.datasetId,
          parentId: null,
          type: 'template',
          name: fields.templateId,
          tagIds: [],
          trainingPolicy: null,
        },
        sourceType: 'text',
        sourceRef: parsed.rawText,
        options: { timeoutMs: 60_000 },
      },
      context,
    );
    response
      .status(200)
      .json(
        successResponse(
          { collectionId: result.collectionId, insertLen: result.insertLen },
          requestId,
        ),
      );
  },
  { validationErrorCode: 501037 },
);
