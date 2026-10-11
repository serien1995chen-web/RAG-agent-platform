import { createHash } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileUploadService } from '../../packages/service/src/index';
import type { RequestContext } from '../../packages/service/src/ports/types';
import type * as SharedApiModule from '../../projects/app/src/shared/api';

const context: RequestContext = {
  requestId: 'req-file-upload',
  tenant: {
    teamId: '000000000000000000000001',
    tmbId: '000000000000000000000002',
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const datasetId = '000000000000000000000010';

const state = vi.hoisted(() => ({
  runtime: undefined as unknown,
  objects: new Map<string, Uint8Array>(),
  deletes: 0,
}));

vi.mock('../../projects/app/src/runtime', () => ({
  getRuntime: async () => state.runtime,
}));

vi.mock('../../projects/app/src/runtime/auth', () => ({
  authenticateRequest: async () => ({ context, subject: context.tenant }),
}));

function responseRecorder(): {
  response: NextApiResponse;
  result: () => { status: number; body: Record<string, unknown> };
} {
  let status = 200;
  let body: unknown = null;
  const response = {
    setHeader: () => response,
    status(code: number) {
      status = code;
      return response;
    },
    json(value: unknown) {
      body = value;
      return response;
    },
  } as unknown as NextApiResponse;
  return { response, result: () => ({ status, body: body as Record<string, unknown> }) };
}

function request(input: {
  method: string;
  url: string;
  query?: Record<string, unknown>;
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

beforeEach(async () => {
  state.objects.clear();
  state.deletes = 0;
  state.runtime = {
    fileUploadService: new FileUploadService(),
    datasetApi: {
      getDatasetDetail: async () => ({ dataset: { datasetId, teamId: context.tenant.teamId } }),
    },
    clients: {
      objectStore: {
        get: async () => ({ body: Buffer.from('a'.repeat(200)) }),
        presignPut: async (input: { ref: { key: string } }) =>
          `https://s3.example/put/${input.ref.key}`,
        presignGet: async (input: { ref: { key: string } }) =>
          `https://s3.example/get/${input.ref.key}`,
        prepareMultipart: async () => ({ multipartUploadId: 'upload-1' }),
        uploadPart: async (input: { partNumber: number; body: Uint8Array }) => {
          const etag = `etag-${input.partNumber}-${input.body.byteLength}`;
          return { etag, partNumber: input.partNumber, size: input.body.byteLength };
        },
        completeMultipart: async () => ({ etag: 'final-etag' }),
        abort: async (input: { ref: { key: string } }) => {
          state.deletes += 1;
          state.objects.delete(input.ref.key);
          return { aborted: true };
        },
      },
    },
  };
});

async function invoke(
  module: { default: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void },
  input: { method: string; url: string; body?: unknown; query?: Record<string, unknown> },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const recorder = responseRecorder();
  await module.default(
    request({ method: input.method, url: input.url, body: input.body, query: input.query }),
    recorder.response,
  );
  return recorder.result();
}

function data(body: Record<string, unknown>): Record<string, unknown> {
  return (body.data ?? {}) as Record<string, unknown>;
}

describe('P4-07 file and multipart routes', () => {
  it('[TEST-FILE-UPLOADPART-001][TEST-TEMPKEY-001] serves the seven routes without internal path leakage', async () => {
    vi.doMock('../../projects/app/src/shared/api', async () => {
      const actual = await vi.importActual<SharedApiModule>('../../projects/app/src/shared/api');
      return {
        ...actual,
        parseDto: (name: string, value: unknown) => {
          if (name === 'UploadPartForm' || name === 'PreviewChunksBody') return value;
          return actual.parseDto(name, value);
        },
      };
    });
    const presignUpload =
      await import('../../projects/app/src/pages/api/core/dataset/file/presignUpload');
    const completeMultipart =
      await import('../../projects/app/src/pages/api/core/dataset/file/completeMultipart');
    const abortMultipart =
      await import('../../projects/app/src/pages/api/core/dataset/file/abortMultipart');
    const previewChunks =
      await import('../../projects/app/src/pages/api/core/dataset/file/previewChunks');
    const presignImage =
      await import('../../projects/app/src/pages/api/core/dataset/file/presignSearchTestImage');
    const imagePreviews =
      await import('../../projects/app/src/pages/api/core/dataset/file/getSearchTestImagePreviewUrls');
    const uploadPart =
      await import('../../projects/app/src/pages/api/core/dataset/file/uploadPart');

    const presign = await invoke(presignUpload, {
      method: 'POST',
      url: '/api/core/dataset/file/presignUpload',
      body: { datasetId, filename: 'a.txt', size: 5, mime: 'text/plain' },
    });
    expect(presign.status).toBe(200);
    const fileId = data(presign.body).fileId as string;
    expect(fileId).toBeTruthy();
    expect(JSON.stringify(data(presign.body))).not.toContain('bucket');
    expect(JSON.stringify(data(presign.body))).not.toContain('kb-source');

    const partOne = await invoke(uploadPart, {
      method: 'POST',
      url: '/api/core/dataset/file/uploadPart',
      body: {
        uploadId: fileId,
        partNumber: 1,
        checksum: 'sum-1',
        chunk: Buffer.from('hello').toString('base64'),
      },
    });
    expect(partOne.status).toBe(200);
    const firstEtag = data(partOne.body).etag;
    expect(firstEtag).toBeTruthy();

    const duplicate = await invoke(uploadPart, {
      method: 'POST',
      url: '/api/core/dataset/file/uploadPart',
      body: {
        uploadId: fileId,
        partNumber: 1,
        checksum: 'sum-1',
        chunk: Buffer.from('hello').toString('base64'),
      },
    });
    expect(data(duplicate.body).etag).toBe(firstEtag);

    const complete = await invoke(completeMultipart, {
      method: 'POST',
      url: '/api/core/dataset/file/completeMultipart',
      body: {
        fileId,
        parts: [{ partNumber: 1, etag: firstEtag }],
        hash: createHash('sha256')
          .update(`1:${String(firstEtag)}:sum-1`)
          .digest('hex'),
      },
    });
    expect(complete.status).toBe(200);
    expect(JSON.stringify(complete.body)).not.toContain('dataset/');

    // complete 成功后 session 已清理；abort 用于进行中的会话，这里开一个新会话再中止。
    const presign2 = await invoke(presignUpload, {
      method: 'POST',
      url: '/api/core/dataset/file/presignUpload',
      body: { datasetId, filename: 'b.txt', size: 5, mime: 'text/plain' },
    });
    const fileId2 = data(presign2.body).fileId as string;
    const abort = await invoke(abortMultipart, {
      method: 'POST',
      url: '/api/core/dataset/file/abortMultipart',
      body: { fileId: fileId2, uploadId: fileId2 },
    });
    expect(abort.status).toBe(200);
    expect(data(abort.body).aborted).toBe(true);
    expect(state.deletes).toBe(1);

    const preview = await invoke(previewChunks, {
      method: 'POST',
      url: '/api/core/dataset/file/previewChunks',
      body: {
        fileRef: `dataset/${datasetId}/${fileId}`,
        chunkPolicy: {
          mode: 'custom',
          chunkSize: 64,
          minSize: 64,
          maxSize: 8000,
          overlapRatio: 0,
          paragraphDeep: 1,
          customRegs: [],
          lengthUnit: 'char',
          forceSplit: true,
          maxChunks: 1000,
        },
      },
    });
    expect(preview.status).toBe(200);
    expect((data(preview.body).chunks as unknown[]).length).toBe(4);

    const imagePresign = await invoke(presignImage, {
      method: 'POST',
      url: '/api/core/dataset/file/presignSearchTestImage',
      body: { filename: 'a.png', size: 10, mime: 'image/png' },
    });
    expect(imagePresign.status).toBe(200);
    expect(data(imagePresign.body).key).toContain(`temp/${context.tenant.teamId}/`);

    const previews = await invoke(imagePreviews, {
      method: 'POST',
      url: '/api/core/dataset/file/getSearchTestImagePreviewUrls',
      body: { keys: [data(imagePresign.body).key as string] },
    });
    expect(previews.status).toBe(200);
    expect((data(previews.body).previewUrls as string[])[0]).toContain('https://');

    for (const result of [
      presign,
      partOne,
      duplicate,
      complete,
      abort,
      preview,
      imagePresign,
      previews,
    ]) {
      expect(JSON.stringify(result.body)).not.toContain('501999');
    }
    vi.doUnmock('../../projects/app/src/shared/api');
  });

  it('[TEST-FILE-UPLOADPART-001] rejects completeMultipart when parts are incomplete', async () => {
    const presignUpload =
      await import('../../projects/app/src/pages/api/core/dataset/file/presignUpload');
    const uploadPart =
      await import('../../projects/app/src/pages/api/core/dataset/file/uploadPart');
    const completeMultipart =
      await import('../../projects/app/src/pages/api/core/dataset/file/completeMultipart');
    const presign = await invoke(presignUpload, {
      method: 'POST',
      url: '/api/core/dataset/file/presignUpload',
      body: { datasetId, filename: 'c.txt', size: 10, mime: 'text/plain' },
    });
    const fileId = data(presign.body).fileId as string;
    const part1 = await invoke(uploadPart, {
      method: 'POST',
      url: '/api/core/dataset/file/uploadPart',
      body: {
        uploadId: fileId,
        partNumber: 1,
        checksum: 's1',
        chunk: Buffer.from('aaa').toString('base64'),
      },
    });
    const part2 = await invoke(uploadPart, {
      method: 'POST',
      url: '/api/core/dataset/file/uploadPart',
      body: {
        uploadId: fileId,
        partNumber: 2,
        checksum: 's2',
        chunk: Buffer.from('bbb').toString('base64'),
      },
    });
    const complete = await invoke(completeMultipart, {
      method: 'POST',
      url: '/api/core/dataset/file/completeMultipart',
      body: {
        fileId,
        parts: [{ partNumber: 1, etag: data(part1.body).etag as string }],
        hash: 'h',
      },
    });
    expect(complete.status).toBe(409);
    expect((complete.body as { code?: number }).code).toBe(501060);
    expect(data(part2.body).etag).toBeTruthy();
  });

  it('rejects cross-team temp image keys with 501061', async () => {
    const imagePreviews =
      await import('../../projects/app/src/pages/api/core/dataset/file/getSearchTestImagePreviewUrls');
    const result = await invoke(imagePreviews, {
      method: 'POST',
      url: '/api/core/dataset/file/getSearchTestImagePreviewUrls',
      body: { keys: ['temp/other-team/key'] },
    });
    expect(result.status).toBe(403);
    expect((result.body as { code?: number }).code).toBe(501061);
  });

  it('rejects an unknown multipart session with 501061', async () => {
    const abortMultipart =
      await import('../../projects/app/src/pages/api/core/dataset/file/abortMultipart');
    const result = await invoke(abortMultipart, {
      method: 'POST',
      url: '/api/core/dataset/file/abortMultipart',
      body: { fileId: '00000000-0000-0000-0000-000000000000', uploadId: 'x' },
    });
    expect(result.status).toBe(403);
    expect((result.body as { code?: number }).code).toBe(501061);
  });
});

// 真实 MinIO 链路：默认跳过；`P4_REAL_MINIO=1 pnpm test:e2e` 时经 API 路由驱动真实存储。
describe.skipIf(process.env.P4_REAL_MINIO !== '1')(
  'P4-07 real MinIO multipart chain via API routes',
  () => {
    it('[TEST-FILE-UPLOADPART-001] drives presign→uploadPart→complete through routes', async () => {
      const { MinioObjectStore } =
        await import('../../sdk/storage/src/adapters/minio-object-store');
      const store = new MinioObjectStore({
        endPoint: '127.0.0.1',
        port: 9000,
        useSSL: false,
        accessKey: 'minioadmin',
        secretKey: 'minioadmin',
        region: 'us-east-1',
        bucket: 'kb-source',
      });
      // 把真实对象存储注入 runtime.clients，路由（presign/uploadPart/complete）走真实 MinIO。
      (state.runtime as { clients: { objectStore: unknown } }).clients.objectStore = store;
      const presignUpload =
        await import('../../projects/app/src/pages/api/core/dataset/file/presignUpload');
      const uploadPart =
        await import('../../projects/app/src/pages/api/core/dataset/file/uploadPart');
      const completeMultipart =
        await import('../../projects/app/src/pages/api/core/dataset/file/completeMultipart');
      const presign = await invoke(presignUpload, {
        method: 'POST',
        url: '/api/core/dataset/file/presignUpload',
        body: { datasetId, filename: 'r.bin', size: 15, mime: 'application/octet-stream' },
      });
      expect(presign.status).toBe(200);
      const fileId = data(presign.body).fileId as string;
      const part = await invoke(uploadPart, {
        method: 'POST',
        url: '/api/core/dataset/file/uploadPart',
        body: {
          uploadId: fileId,
          partNumber: 1,
          checksum: 'c1',
          chunk: Buffer.from('real-minio-part').toString('base64'),
        },
      });
      expect(part.status).toBe(200);
      const etag = data(part.body).etag as string;
      expect(etag).toBeTruthy();
      const complete = await invoke(completeMultipart, {
        method: 'POST',
        url: '/api/core/dataset/file/completeMultipart',
        body: {
          fileId,
          parts: [{ partNumber: 1, etag }],
          hash: createHash('sha256').update(`1:${etag}:c1`).digest('hex'),
        },
      });
      expect(complete.status).toBe(200);
    }, 30000);
  },
);
