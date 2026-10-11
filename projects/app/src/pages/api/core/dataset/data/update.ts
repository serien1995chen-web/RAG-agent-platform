import { createHash } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { KnowledgeItemSnapshot } from '@kb/service';
import type { ExtendedAppRuntime } from '../../../../../runtime';
import { authenticateRequest } from '../../../../../runtime/auth';
import { getRuntime } from '../../../../../runtime';
import { parseDto, successResponse, withApiHandler } from '../../../../../shared/api';
import type { ApiHandlerContext } from '../../../../../shared/api';

const PORT_OPTIONS = { timeoutMs: 10_000 } as const;
function apiError(
  code: number,
  requestId: string,
  params: Record<string, unknown>,
): ApiErrorException {
  return new ApiErrorException(createApiError({ code, requestId, params }));
}

interface IndexPatchValue {
  indexId: string;
  text: string;
  version: number;
}

interface DataUpdateBody {
  dataId: string;
  version: number;
  q?: string;
  a?: string;
  indexes?: IndexPatchValue[];
}

interface ExistingItem {
  version: number;
  q?: string;
  a?: string;
  datasetId: string;
  collectionId: string;
  indexes: Array<{ indexId: string; type: string; dataId: string; text: string }>;
}

function localEmbedding(text: string): number[] {
  const bytes = createHash('sha256').update(text, 'utf8').digest();
  const vector: number[] = [];
  for (let index = 0; index < 64; index += 1) {
    vector.push((bytes[index % bytes.length] ?? 0) / 255);
  }
  return vector;
}

/** API-DATA-003 POST /api/core/dataset/data/update */
export default withApiHandler(
  async (request: NextApiRequest, response: NextApiResponse, { requestId }: ApiHandlerContext) => {
    const runtime = (await getRuntime()) as ExtendedAppRuntime;
    const { context } = await authenticateRequest(runtime, request, requestId);
    const body = parseDto<DataUpdateBody>('DataUpdateBody', request.body);
    const repository = runtime.knowledgeItemRepository as typeof runtime.knowledgeItemRepository & {
      get?: (input: {
        dataId: string;
        options: typeof PORT_OPTIONS;
      }) => Promise<ExistingItem | null>;
    };
    const existing = await repository.get?.({ dataId: body.dataId, options: PORT_OPTIONS });
    if (!existing) {
      throw apiError(501070, requestId, { dataId: body.dataId });
    }
    if (existing.version !== body.version) {
      throw apiError(501067, requestId, { expected: existing.version, actual: body.version });
    }
    const nextQ = body.q ?? existing.q ?? '';
    const nextA = body.a ?? existing.a ?? '';
    const nextIndexes: ExistingItem['indexes'] = [...existing.indexes];
    for (const patch of body.indexes ?? []) {
      const current = nextIndexes.find((index) => index.indexId === patch.indexId);
      if (current) {
        current.text = patch.text;
      } else {
        nextIndexes.push({
          indexId: patch.indexId,
          type: 'custom',
          dataId: body.dataId,
          text: patch.text,
        });
      }
    }
    const text = nextA.length > 0 ? `${nextQ}\n${nextA}` : nextQ;
    const vectorController = runtime.vectorController ?? runtime.ports.vectorController;
    const fullText = runtime.fullTextStore ?? runtime.ports.fullTextStore;
    await vectorController.insert(
      {
        records: [
          {
            dataId: body.dataId,
            teamId: context.tenant.teamId,
            datasetId: existing.datasetId,
            collectionId: existing.collectionId,
            indexId: `${body.dataId}:default`,
            indexVersion: '1',
            vector: localEmbedding(text),
          },
        ],
        options: PORT_OPTIONS,
      },
      context,
    );
    const cas = await repository.updateIndexes(
      {
        dataId: body.dataId,
        version: body.version,
        indexes: nextIndexes,
        options: PORT_OPTIONS,
      },
      context,
    );
    const item: KnowledgeItemSnapshot = {
      dataId: body.dataId,
      teamId: context.tenant.teamId,
      datasetId: existing.datasetId,
      collectionId: existing.collectionId,
      q: nextQ,
      a: nextA,
      indexes: nextIndexes,
      rebuilding: false,
      version: cas.version,
      createTime: new Date().toISOString(),
      updateTime: new Date().toISOString(),
    };
    await repository.bulkUpsert({ items: [item], options: PORT_OPTIONS }, context);
    await fullText.write(
      {
        datasetId: existing.datasetId,
        collectionId: existing.collectionId,
        dataId: body.dataId,
        text,
        options: PORT_OPTIONS,
      },
      context,
    );
    const updated = { dataId: body.dataId, version: cas.version };
    response
      .status(200)
      .json(successResponse({ dataId: updated.dataId, version: updated.version }, requestId));
  },
  { validationErrorCode: 501067 },
);
