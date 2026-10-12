import { ApiErrorException, createApiError } from '@kb/contracts';
import { createDefaultDocumentParser, type DocumentParseContext } from '@kb/parse';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';
import { readMultipartForm } from '../../file/presignUpload';
import { buildImportSource } from './file';

const MAX_DATA_ROWS = 10000;

interface BackupFields {
  file: Uint8Array;
  datasetId: string;
  parentId?: string;
  mapping?: { columns?: { sourceColumn?: string }[] };
}

function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,12})$/.exec(filename);
  return (match?.[1] ?? '').toLowerCase();
}

/** API-COL-009 POST /api/core/dataset/collection/create/backup */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const form = readMultipartForm(request);
    const filePart = form.files.file;
    if (!filePart || filePart.content.byteLength === 0) {
      throw new ApiErrorException(
        createApiError({
          code: 501059,
          requestId,
          params: { sheetName: '', reason: 'missing_file', limit: 1 },
        }),
      );
    }
    let mapping: BackupFields['mapping'];
    if (form.fields.mapping !== undefined) {
      try {
        mapping = JSON.parse(form.fields.mapping) as BackupFields['mapping'];
      } catch {
        throw new ApiErrorException(
          createApiError({
            code: 501058,
            requestId,
            params: { missingHeaders: [], duplicateHeaders: [] },
          }),
        );
      }
    }
    const fields = parseDto<BackupFields>('CollectionCreateBackupForm', {
      file: filePart.content,
      datasetId: form.fields.datasetId,
      ...(form.fields.parentId !== undefined ? { parentId: form.fields.parentId } : {}),
      ...(mapping !== undefined ? { mapping } : {}),
    });
    const parseRequest: DocumentParseContext = {
      teamId: context.tenant.teamId,
      datasetId: fields.datasetId,
      fileRef: filePart.filename,
      extension: extensionOf(filePart.filename),
      timeoutMs: 60_000,
      bytes: filePart.content,
    };
    const parsed = await createDefaultDocumentParser().parse(parseRequest);
    const lines = parsed.rawText.split('\n').filter((line) => line.trim().length > 0);
    if (parsed.rawText.trim().length === 0) {
      throw new ApiErrorException(
        createApiError({
          code: 501059,
          requestId,
          params: { sheetName: '', reason: 'empty_sheet', limit: 1 },
        }),
      );
    }
    const headerLine = lines[0] ?? '';
    if (fields.mapping) {
      const missing = (fields.mapping.columns ?? [])
        .map((column) => column.sourceColumn ?? '')
        .filter((name) => name.length > 0 && !headerLine.includes(name));
      if (missing.length > 0) {
        throw new ApiErrorException(
          createApiError({
            code: 501058,
            requestId,
            params: { missingHeaders: missing, duplicateHeaders: [] },
          }),
        );
      }
    }
    const dataRows = Math.max(lines.length - 1, 0);
    if (dataRows > MAX_DATA_ROWS) {
      throw new ApiErrorException(
        createApiError({
          code: 501030,
          requestId,
          params: { limit: MAX_DATA_ROWS, actual: dataRows },
        }),
      );
    }
    const service = buildImportSource(runtime);
    const result = await service.createCollectionFromSource(
      {
        collection: {
          teamId: context.tenant.teamId,
          datasetId: fields.datasetId,
          parentId: fields.parentId ?? null,
          type: 'backup',
          name: filePart.filename || 'backup',
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
  { validationErrorCode: 501030 },
);
