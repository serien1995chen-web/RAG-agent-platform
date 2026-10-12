import { ApiErrorException, createApiError } from '@kb/contracts';
import { createDefaultDocumentParser, type DocumentParseContext } from '@kb/parse';
import type { NextApiRequest, NextApiResponse } from 'next';
import { authenticateRequest } from '../../../../../../runtime/auth';
import { getRuntime } from '../../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../../shared/api';
import { readMultipartForm } from '../../file/presignUpload';
import { buildImportSource } from './file';

interface TemplateFields {
  file: Uint8Array;
  datasetId: string;
  templateId: string;
}

function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,12})$/.exec(filename);
  return (match?.[1] ?? '').toLowerCase();
}

function templateError(requestId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501037,
      requestId,
      params: { templateId: '' },
    }),
  );
}

/** API-COL-010 POST /api/core/dataset/collection/create/template */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = await getRuntime();
    const { context } = await authenticateRequest(runtime, request, requestId);
    const form = readMultipartForm(request);
    const filePart = form.files.file;
    if (!filePart || filePart.content.byteLength === 0) throw templateError(requestId);
    const fields = parseDto<TemplateFields>('CollectionCreateTemplateForm', {
      file: filePart.content,
      datasetId: form.fields.datasetId,
      templateId: form.fields.templateId,
    });
    const parseRequest: DocumentParseContext = {
      teamId: context.tenant.teamId,
      datasetId: fields.datasetId,
      fileRef: filePart.filename,
      extension: extensionOf(filePart.filename),
      timeoutMs: 60_000,
      bytes: filePart.content,
    };
    let rawText: string;
    try {
      rawText = (await createDefaultDocumentParser().parse(parseRequest)).rawText;
    } catch {
      throw templateError(requestId);
    }
    if (rawText.trim().length === 0) throw templateError(requestId);
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
        sourceRef: rawText,
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
