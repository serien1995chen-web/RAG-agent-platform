import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../../packages/service/src/ports/types';
import type * as ItemRepositoryModule from '../../packages/service/src/modules/item/repository/index';

const TEAM_ID = '000000000000000000000001';
const DATASET_ID = '0000000000000000000000d1';

const context: RequestContext = {
  requestId: 'req-collection-create',
  tenant: { teamId: TEAM_ID, tmbId: '000000000000000000000002', authType: 'token', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

interface State {
  collections: { teamId: string; datasetId: string; type: string; trainingPolicy?: unknown }[];
  enqueued: string[];
  deleted: string[];
  apiConfigs: unknown[];
  trainingStates: string[];
  createFailAt: number;
  runtime: unknown;
}

const state = vi.hoisted<State>(() => ({
  collections: [],
  enqueued: [],
  deleted: [],
  apiConfigs: [],
  trainingStates: [],
  createFailAt: -1,
  runtime: undefined,
}));

vi.mock('../../projects/app/src/runtime', () => ({
  getRuntime: async () => state.runtime,
}));

vi.mock('../../projects/app/src/runtime/auth', () => ({
  authenticateRequest: async () => ({ context, subject: context.tenant }),
}));

vi.mock('../../packages/service/src/modules/item/repository/index', async (importOriginal) => {
  const actual = await importOriginal<typeof ItemRepositoryModule>();
  return {
    ...actual,
    createImageAssetRepository: () => ({
      createTemporary: async (input: { imageId: string }) => ({
        imageId: input.imageId,
        state: 'temporary',
        ttlExpireAt: new Date(),
      }),
      findById: async () => null,
      promoteToReferenced: async (imageId: string) => ({ imageId, state: 'referenced' }),
      markFailed: async () => undefined,
    }),
  };
});

function responseRecorder(): {
  response: NextApiResponse;
  result: () => { status: number; body: { data?: unknown; code?: number } };
} {
  let status = 200;
  let body: { data?: unknown; code?: number } = {};
  const response = {
    setHeader: () => response,
    status(code: number) {
      status = code;
      return response;
    },
    json(value: unknown) {
      body = value as { data?: unknown; code?: number };
      return response;
    },
  } as unknown as NextApiResponse;
  return { response, result: () => ({ status, body }) };
}

function request(input: {
  method: string;
  url: string;
  query?: Record<string, string>;
  body?: unknown;
}): NextApiRequest {
  return {
    method: input.method,
    url: input.url,
    query: input.query ?? {},
    body: input.body,
    headers: {},
  } as unknown as NextApiRequest;
}

let collectionSeq = 0;

function buildRuntime() {
  collectionSeq = 0;
  return {
    collectionRepository: {
      create: async (input: {
        collection: { teamId: string; datasetId: string; type: string; trainingPolicy?: unknown };
      }) => {
        collectionSeq += 1;
        if (state.createFailAt === collectionSeq) throw new Error('create_failed');
        state.collections.push(input.collection);
        return { collectionId: `col-${collectionSeq}` };
      },
      deleteTree: async (input: { collectionId: string }) => {
        state.deleted.push(input.collectionId);
        return { deleteJobId: 'del-' + input.collectionId };
      },
      markTrainingState: async (input: { trainingState: string }) => {
        state.trainingStates.push(input.trainingState);
      },
    },
    datasetSourceProvider: {
      read: async (sourceRequest: {
        sourceType: string;
        sourceRef: string;
        apiConfig?: unknown;
      }) => {
        state.apiConfigs.push(sourceRequest.apiConfig);
        const rawText = sourceRequest.sourceType === 'text' ? sourceRequest.sourceRef : 'content';
        return { rawText, contentHash: 'hash' };
      },
      preview: async (sourceRequest: { sourceType: string; sourceRef: string }) => ({
        rawText: sourceRequest.sourceType === 'text' ? sourceRequest.sourceRef : 'content',
        contentHash: 'hash',
      }),
    },
    processingRepository: {
      enqueue: async () => {
        state.enqueued.push('task');
        return { taskId: 'task-1', jobId: 'job-1' };
      },
    },
    knowledgeItemRepository: { bulkUpsert: async () => ({ upserted: 1, duplicates: 0 }) },
    vectorController: { insert: async () => ({ inserted: 1 }) },
    fullTextStore: { write: async () => undefined },
    datasetApi: {
      createDataset: async () => ({ datasetId: DATASET_ID, state: 'ready' }),
      getDatasetDetail: async () => ({
        dataset: { datasetId: DATASET_ID, vectorModel: 'bge-m3', indexVersion: 'bge-m3:1536:v1' },
        stats: { collections: 0, datas: 0 },
      }),
    },
    imageCapability: {},
    ports: {
      trainingProcessor: { process: async () => ({ state: 'success' }) },
      imageTrainingProcessor: {
        processImage: async () => ({
          imageId: 'image-1',
          state: 'success',
          embedding: new Array<number>(1536).fill(0.1),
        }),
      },
      objectStore: {
        get: async () => ({
          ref: { bucket: 'kb-objects', key: 'k' },
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP478+AFWEXHbQSAOBoU4FwyX8rAAAAAElFTkSuQmCC',
            'base64',
          ),
        }),
      },
    },
    clients: {
      queue: {
        enqueue: async () => ({ jobId: 'job-1', enqueued: true }),
        remove: async () => undefined,
        close: async () => undefined,
      },
      redis: undefined,
      mongo: undefined,
    },
    config: {
      system: { s3: { bucket: 'kb-objects' } },
      datasetRuntime: { maxImagesPerRequest: 10, maxRequestBodyBytes: 10 * 1024 * 1024 },
    },
  };
}

beforeEach(() => {
  state.collections = [];
  state.enqueued = [];
  state.deleted = [];
  state.apiConfigs = [];
  state.createFailAt = -1;
  state.trainingStates = [];
  state.runtime = buildRuntime();
});

async function signFileToken(key: string): Promise<string> {
  const { signUploadToken } =
    await import('../../projects/app/src/pages/api/core/dataset/file/presignUpload');
  return signUploadToken({
    kind: 'file',
    teamId: TEAM_ID,
    datasetId: DATASET_ID,
    bucket: 'kb-objects',
    key,
    uploadId: '',
    expiresAt: Date.now() + 60_000,
  });
}

describe('TEST-E2E-INGEST-001 P4-08 collection create routes', () => {
  it('creates collections from text/file/link/externalFile without 501999', async () => {
    const text = (
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/text')
    ).default;
    const file = (
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/file')
    ).default;
    const link = (
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/link')
    ).default;
    const externalFile = (
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/externalFile')
    ).default;

    const textRes = responseRecorder();
    await text(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/create/text',
        body: { datasetId: DATASET_ID, text: 'hello world' },
      }),
      textRes.response,
    );
    expect(textRes.result().status).toBe(200);
    expect(state.collections.at(-1)?.type).toBe('text');

    const fileRes = responseRecorder();
    await file(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/create/file',
        body: {
          datasetId: DATASET_ID,
          fileId: await signFileToken(`dataset/${DATASET_ID}/uploads/a.md`),
        },
      }),
      fileRes.response,
    );
    expect(fileRes.result().status).toBe(200);

    const linkRes = responseRecorder();
    await link(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/create/link',
        body: { datasetId: DATASET_ID, link: 'https://example.com/page' },
      }),
      linkRes.response,
    );
    expect(linkRes.result().status).toBe(200);
    expect((linkRes.result().body.data as { state: string }).state).toBe('ready');

    const extRes = responseRecorder();
    await externalFile(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/create/externalFile',
        body: { datasetId: DATASET_ID, provider: 'custom', fileKey: 'dataset/d1/a.pdf' },
      }),
      extRes.response,
    );
    expect(extRes.result().status).toBe(200);
  });

  it('empty text import succeeds with insertLen=0 and no task', async () => {
    const text = (
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/text')
    ).default;
    const res = responseRecorder();
    await text(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/create/text',
        body: { datasetId: DATASET_ID, text: '   ' },
      }),
      res.response,
    );
    expect(res.result().status).toBe(200);
    expect((res.result().body.data as { insertLen: number }).insertLen).toBe(0);
    expect(state.enqueued).toHaveLength(0);
  });

  it('rewrites images trainingType=auto to chunk + autoIndexes', async () => {
    const images = (
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/images')
    ).default;
    const res = responseRecorder();
    await images(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/create/images',
        body: {
          datasetId: DATASET_ID,
          images: [`dataset/${DATASET_ID}/uploads/image-1.png`],
          trainingType: 'auto',
        },
      }),
      res.response,
    );
    expect(res.result().status).toBe(200);
    // ISSUE-002：训练模式独立落库，不再复用 chunkPolicy.mode。
    expect(state.collections.at(-1)?.trainingMode).toBe('chunk');
    expect(state.collections.at(-1)?.autoIndexes).toBe(true);
  });

  it('marks the collection error when a single image fails', async () => {
    const images = (
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/images')
    ).default;
    const runtime = state.runtime as {
      ports: { imageTrainingProcessor: { processImage: unknown } };
    };
    runtime.ports.imageTrainingProcessor.processImage = async () => ({
      imageId: 'image-1',
      state: 'failed',
      errorMsg: 'provider_down',
    });
    const res = responseRecorder();
    await images(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/create/images',
        body: {
          datasetId: DATASET_ID,
          images: [`dataset/${DATASET_ID}/uploads/image-1.png`],
          trainingType: 'auto',
        },
      }),
      res.response,
    );
    expect(res.result().status).toBe(200);
    const items = (res.result().body.data as { items: { state: string }[] }).items;
    expect(items[0]?.state).toBe('failed');
    expect(state.trainingStates).toContain('error');
  });
});

describe('TEST-API-IMPORT-001 P4-08 backup/template validation', () => {
  it('serves backup and template with parsed csv', async () => {
    const backup = (
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/backup')
    ).default;
    const template = (
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/template')
    ).default;
    const csv = Buffer.from('q,a\nhello,world\n');

    const backupRes = responseRecorder();
    await backup(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/create/backup',
        body: {
          datasetId: DATASET_ID,
          file: { filename: 'backup.csv', content: csv },
        },
      }),
      backupRes.response,
    );
    expect(backupRes.result().status).toBe(200);

    const templateRes = responseRecorder();
    await template(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/create/template',
        body: {
          datasetId: DATASET_ID,
          templateId: 'tpl-1',
          file: { filename: 't.csv', content: csv },
        },
      }),
      templateRes.response,
    );
    expect(templateRes.result().status).toBe(200);
  });

  it('rejects an invalid backup header mapping with 501058', async () => {
    const backup = (
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/backup')
    ).default;
    const res = responseRecorder();
    await backup(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/create/backup',
        body: {
          datasetId: DATASET_ID,
          file: { filename: 'backup.csv', content: Buffer.from('q,a\nhello,world\n') },
          mapping: JSON.stringify({
            sourceFormat: 'csv',
            columns: [{ sourceColumn: 'missing', targetField: 'q', targetType: 'string' }],
          }),
        },
      }),
      res.response,
    );
    expect(res.result().body.code).toBe(501058);
  });
});

describe('TEST-API-IMPORT-DATASET-001 P4-08 createWithFiles and apiFile', () => {
  it('creates a dataset with files in one request', async () => {
    const createWithFiles = (
      await import('../../projects/app/src/pages/api/core/dataset/createWithFiles')
    ).default;
    const res = responseRecorder();
    await createWithFiles(
      request({
        method: 'POST',
        url: '/api/core/dataset/createWithFiles',
        body: {
          datasetParams: {
            name: 'agg',
            type: 'dataset',
            models: { embeddingModel: 'bge-m3' },
          },
          files: [await signFileToken(`dataset/${DATASET_ID}/uploads/a.md`)],
        },
      }),
      res.response,
    );
    expect(res.result().status).toBe(200);
    expect((res.result().body.data as { datasetId: string }).datasetId).toBe(DATASET_ID);
  });

  it('rejects more than 10 files with 501030 and cleans up on failure', async () => {
    const createWithFiles = (
      await import('../../projects/app/src/pages/api/core/dataset/createWithFiles')
    ).default;
    const tooMany = responseRecorder();
    await createWithFiles(
      request({
        method: 'POST',
        url: '/api/core/dataset/createWithFiles',
        body: {
          datasetParams: { name: 'agg', type: 'dataset', models: { embeddingModel: 'bge-m3' } },
          files: Array.from({ length: 11 }, () => 'x'),
        },
      }),
      tooMany.response,
    );
    expect(tooMany.result().body.code).toBe(501030);

    state.createFailAt = 2;
    const failed = responseRecorder();
    await createWithFiles(
      request({
        method: 'POST',
        url: '/api/core/dataset/createWithFiles',
        body: {
          datasetParams: { name: 'agg', type: 'dataset', models: { embeddingModel: 'bge-m3' } },
          files: [
            await signFileToken(`dataset/${DATASET_ID}/uploads/a.md`),
            await signFileToken(`dataset/${DATASET_ID}/uploads/b.md`),
          ],
        },
      }),
      failed.response,
    );
    expect(failed.result().body.code).toBe(501998);
    expect(state.deleted).toEqual(['col-1']);
  });

  it('forwards apiConfig to the provider for apiFile sources', async () => {
    const apiFile = (
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/apiFile')
    ).default;
    const apiConfig = {
      provider: 'custom',
      credentialRef: 'ref',
      capabilities: [{ name: 'read', supported: true }],
    };
    const res = responseRecorder();
    await apiFile(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/create/apiFile',
        body: { datasetId: DATASET_ID, apiConfig, path: '/docs/a.md' },
      }),
      res.response,
    );
    expect(res.result().status).toBe(200);
    expect(state.apiConfigs).toContainEqual(
      expect.objectContaining({ provider: 'custom', credentialRef: 'ref' }),
    );
  });
});

describe('P-7 backup/template validation', () => {
  it('rejects non CSV/XLSX backups with 501059 and missing headers with 501058', async () => {
    const backup = (
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/backup')
    ).default;
    const before = state.collections.length;

    const wrongExt = responseRecorder();
    await backup(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/create/backup',
        body: { datasetId: DATASET_ID, file: { filename: 'notes.txt', content: Buffer.from('x') } },
      }),
      wrongExt.response,
    );
    expect(wrongExt.result().body.code).toBe(501059);

    const missingQ = responseRecorder();
    await backup(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/create/backup',
        body: {
          datasetId: DATASET_ID,
          file: { filename: 'b.csv', content: Buffer.from('q,b\nhello,world\n') },
        },
      }),
      missingQ.response,
    );
    expect(missingQ.result().body.code).toBe(501058);

    const duplicate = responseRecorder();
    await backup(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/create/backup',
        body: {
          datasetId: DATASET_ID,
          file: { filename: 'b.csv', content: Buffer.from('q,q,a\n1,2,3\n') },
        },
      }),
      duplicate.response,
    );
    expect(duplicate.result().body.code).toBe(501058);
    expect(state.collections.length).toBe(before);
  });

  it('rejects a backup whose mapping references a missing required column', async () => {
    const backup = (
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/backup')
    ).default;
    const res = responseRecorder();
    await backup(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/create/backup',
        body: {
          datasetId: DATASET_ID,
          file: { filename: 'b.csv', content: Buffer.from('q,a\nhi,yo\n') },
          mapping: JSON.stringify({
            sourceFormat: 'csv',
            columns: [
              { sourceColumn: 'missing', targetField: 'q', targetType: 'string', required: true },
              { sourceColumn: 'a', targetField: 'a', targetType: 'string' },
            ],
          }),
        },
      }),
      res.response,
    );
    expect(res.result().body.code).toBe(501058);
  });

  it('returns 501037 for a missing template and 501056 for a non CSV/XLSX template', async () => {
    const template = (
      await import('../../projects/app/src/pages/api/core/dataset/collection/create/template')
    ).default;

    const missingFile = responseRecorder();
    await template(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/create/template',
        body: { datasetId: DATASET_ID, templateId: 'tpl-x' },
      }),
      missingFile.response,
    );
    expect(missingFile.result().body.code).toBe(501037);

    const wrongExt = responseRecorder();
    await template(
      request({
        method: 'POST',
        url: '/api/core/dataset/collection/create/template',
        body: {
          datasetId: DATASET_ID,
          templateId: 'tpl-x',
          file: { filename: 't.txt', content: Buffer.from('q,a\n1,2\n') },
        },
      }),
      wrongExt.response,
    );
    expect(wrongExt.result().body.code).toBe(501056);
  });
});
