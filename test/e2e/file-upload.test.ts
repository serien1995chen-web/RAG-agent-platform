import { createHash } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../../packages/service/src/ports/types';

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
  redis: new Map<string, string>(),
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

beforeEach(() => {
  state.redis.clear();
  state.deletes = 0;
  const objectStore = {
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
    abort: async () => {
      state.deletes += 1;
      return { aborted: true };
    },
  };
  const redis = {
    get: async (key: string) => state.redis.get(key) ?? null,
    set: async (key: string, value: string) => {
      state.redis.set(key, value);
      return 'OK';
    },
    del: async (...keys: string[]) => {
      for (const key of keys) state.redis.delete(key);
      return keys.length;
    },
  };
  state.runtime = {
    config: {
      datasetRuntime: {
        maxRequestBodyBytes: 10 * 1024 * 1024,
        maxRawTextBytes: 10 * 1024 * 1024,
        maxPushItems: 200,
      },
      system: { s3: { bucket: 'kb-source' } },
    },
    datasetApi: {
      getDatasetDetail: async () => ({ dataset: { datasetId, teamId: context.tenant.teamId } }),
    },
    clients: { objectStore, redis },
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
        chunk: Buffer.from('hello'),
      },
    });
    expect(partOne.status).toBe(200);
    const firstEtag = data(partOne.body).etag as string;
    expect(firstEtag).toBeTruthy();

    const duplicate = await invoke(uploadPart, {
      method: 'POST',
      url: '/api/core/dataset/file/uploadPart',
      body: {
        uploadId: fileId,
        partNumber: 1,
        checksum: 'sum-1',
        chunk: Buffer.from('hello'),
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
    await invoke(uploadPart, {
      method: 'POST',
      url: '/api/core/dataset/file/uploadPart',
      body: {
        uploadId: fileId,
        partNumber: 1,
        checksum: 's1',
        chunk: Buffer.from('aaa'),
      },
    });
    await invoke(uploadPart, {
      method: 'POST',
      url: '/api/core/dataset/file/uploadPart',
      body: {
        uploadId: fileId,
        partNumber: 2,
        checksum: 's2',
        chunk: Buffer.from('bbb'),
      },
    });
    const complete = await invoke(completeMultipart, {
      method: 'POST',
      url: '/api/core/dataset/file/completeMultipart',
      body: {
        fileId,
        parts: [{ partNumber: 1, etag: 'etag-1-3' }],
        hash: 'h',
      },
    });
    expect(complete.status).toBe(409);
    expect((complete.body as { code?: number }).code).toBe(501060);
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

  it('[TEST-TEMPKEY-001] treats an already-aborted multipart session as idempotent success', async () => {
    const abortMultipart =
      await import('../../projects/app/src/pages/api/core/dataset/file/abortMultipart');
    const result = await invoke(abortMultipart, {
      method: 'POST',
      url: '/api/core/dataset/file/abortMultipart',
      body: { fileId: '00000000-0000-0000-0000-000000000000', uploadId: 'x' },
    });
    expect(result.status).toBe(200);
    expect(data(result.body).aborted).toBe(true);
  });

  it('[TEST-TEMPKEY-001] rejects expired temp image keys with 501011', async () => {
    const presignImage =
      await import('../../projects/app/src/pages/api/core/dataset/file/presignSearchTestImage');
    const imagePreviews =
      await import('../../projects/app/src/pages/api/core/dataset/file/getSearchTestImagePreviewUrls');
    const presign = await invoke(presignImage, {
      method: 'POST',
      url: '/api/core/dataset/file/presignSearchTestImage',
      body: { filename: 'expired.png', size: 1, mime: 'image/png' },
    });
    const key = data(presign.body).key as string;
    state.redis.set(
      `p4:temp-key:${context.tenant.teamId}:${Buffer.from(key).toString('base64url')}`,
      new Date(Date.now() - 1000).toISOString(),
    );
    const result = await invoke(imagePreviews, {
      method: 'POST',
      url: '/api/core/dataset/file/getSearchTestImagePreviewUrls',
      body: { keys: [key] },
    });
    expect(result.status).toBe(410);
    expect((result.body as { code?: number }).code).toBe(501011);
  });
});
