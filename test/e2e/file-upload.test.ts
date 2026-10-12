import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiErrorException, createApiError } from '../../packages/contracts/src/index';
import type { RequestContext } from '../../packages/service/src/ports/types';

const TEAM_ID = '000000000000000000000001';
const OTHER_TEAM_ID = '0000000000000000000000ff';
const DATASET_ID = '0000000000000000000000d1';

const context: RequestContext = {
  requestId: 'req-file-upload',
  tenant: { teamId: TEAM_ID, tmbId: '000000000000000000000002', authType: 'token', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const state = vi.hoisted(() => ({
  uploaded: [] as string[],
  aborted: new Set<string>(),
  storage: undefined as unknown,
}));

vi.mock('../../projects/app/src/runtime', () => ({
  getRuntime: async () => ({
    clients: { objectStore: state.storage },
    config: { system: { s3: { bucket: 'kb-objects' } } },
  }),
}));

vi.mock('../../projects/app/src/runtime/auth', () => ({
  authenticateRequest: async () => ({ context, subject: context.tenant }),
}));

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
  headers?: Record<string, string>;
}): NextApiRequest {
  return {
    method: input.method,
    url: input.url,
    query: input.query ?? {},
    body: input.body,
    headers: input.headers ?? {},
  } as unknown as NextApiRequest;
}

const storage = {
  ensureBucket: async () => undefined,
  put: async ({ ref }: { ref: { bucket: string; key: string } }) => ref,
  get: async ({ ref }: { ref: { bucket: string; key: string } }) => ({
    ref,
    body: Buffer.from('# hello\n\nworld paragraph text for chunking preview\n'),
  }),
  delete: async () => ({ deleted: true }),
  promote: async ({ ref }: { ref: { bucket: string; key: string } }) => ref,
  prepareMultipart: async ({ ref }: { ref: { bucket: string; key: string } }) => ({
    ...ref,
    multipartUploadId: 'upload-session-1',
  }),
  uploadPart: async ({
    ref,
    partNumber,
    body,
    checksum,
    uploadId,
  }: {
    ref: { bucket: string; key: string };
    partNumber: number;
    body: Uint8Array;
    checksum: string;
    uploadId: string;
  }) => {
    state.uploaded.push(`${ref.key}#${uploadId}#${partNumber}#${checksum}`);
    return { partNumber, etag: `etag-${partNumber}-${checksum}`, size: body.byteLength };
  },
  completeMultipart: async ({ ref }: { ref: { bucket: string; key: string } }) => ({
    ...ref,
    size: 4,
    etag: 'final-etag',
  }),
  abort: async ({ ref }: { ref: { bucket: string; key: string } }) => {
    if (state.aborted.has(ref.key)) {
      throw new ApiErrorException(
        createApiError({ code: 501015, requestId: 'object-store', params: {} }),
      );
    }
    state.aborted.add(ref.key);
    return { aborted: true };
  },
};

const chunkPolicy = {
  mode: 'auto',
  chunkSize: 1000,
  minSize: 1,
  maxSize: 8000,
  overlapRatio: 0,
  paragraphDeep: 5,
  customRegs: [],
  lengthUnit: 'token',
  forceSplit: true,
  maxChunks: 50000,
};

async function importRoutes() {
  return {
    presignUpload: (
      await import('../../projects/app/src/pages/api/core/dataset/file/presignUpload')
    ).default,
    uploadPart: (await import('../../projects/app/src/pages/api/core/dataset/file/uploadPart'))
      .default,
    completeMultipart: (
      await import('../../projects/app/src/pages/api/core/dataset/file/completeMultipart')
    ).default,
    abortMultipart: (
      await import('../../projects/app/src/pages/api/core/dataset/file/abortMultipart')
    ).default,
    previewChunks: (
      await import('../../projects/app/src/pages/api/core/dataset/file/previewChunks')
    ).default,
    presignSearchTestImage: (
      await import('../../projects/app/src/pages/api/core/dataset/file/presignSearchTestImage')
    ).default,
    getSearchTestImagePreviewUrls: (
      await import('../../projects/app/src/pages/api/core/dataset/file/getSearchTestImagePreviewUrls')
    ).default,
  };
}

beforeEach(() => {
  state.uploaded = [];
  state.aborted = new Set<string>();
  state.storage = storage;
});

describe('TEST-FILE-UPLOADPART-001 P4-07 file routes', () => {
  it('serves presignUpload/uploadPart/completeMultipart/abortMultipart without 501999', async () => {
    const routes = await importRoutes();

    const presigned = responseRecorder();
    await routes.presignUpload(
      request({
        method: 'POST',
        url: '/api/core/dataset/file/presignUpload',
        body: { datasetId: DATASET_ID, filename: 'notes.md', size: 42, mime: 'text/markdown' },
      }),
      presigned.response,
    );
    expect(presigned.result().status).toBe(200);
    const presignData = presigned.result().body.data as {
      uploadUrl: string;
      fileId: string;
      expiresAt: string;
    };
    expect(presignData.uploadUrl).toBe('/api/core/dataset/file/uploadPart');
    expect(presignData.fileId).not.toContain('dataset/');
    expect(typeof presignData.expiresAt).toBe('string');

    const partOne = responseRecorder();
    const part1 = {
      uploadId: 'upload-session-1',
      partNumber: 1,
      chunk: new Uint8Array([1, 2, 3]),
      checksum: 'sha256:abc',
    };
    await routes.uploadPart(
      request({
        method: 'POST',
        url: '/api/core/dataset/file/uploadPart',
        query: { fileId: presignData.fileId },
        body: part1,
      }),
      partOne.response,
    );
    const firstEtag = (partOne.result().body.data as { etag: string }).etag;
    expect(partOne.result().status).toBe(200);

    const partTwo = responseRecorder();
    await routes.uploadPart(
      request({
        method: 'POST',
        url: '/api/core/dataset/file/uploadPart',
        query: { fileId: presignData.fileId },
        body: part1,
      }),
      partTwo.response,
    );
    expect((partTwo.result().body.data as { etag: string }).etag).toBe(firstEtag);

    const completed = responseRecorder();
    await routes.completeMultipart(
      request({
        method: 'POST',
        url: '/api/core/dataset/file/completeMultipart',
        body: {
          fileId: presignData.fileId,
          parts: [{ partNumber: 1, etag: firstEtag }],
          hash: 'sha256:abc',
        },
      }),
      completed.response,
    );
    expect(completed.result().status).toBe(200);
    const fileRef = (completed.result().body.data as { fileRef: string }).fileRef;
    expect(fileRef).not.toContain('dataset/');

    const aborted = responseRecorder();
    await routes.abortMultipart(
      request({
        method: 'POST',
        url: '/api/core/dataset/file/abortMultipart',
        body: { fileId: presignData.fileId, uploadId: 'upload-session-1' },
      }),
      aborted.response,
    );
    expect((aborted.result().body.data as { aborted: boolean }).aborted).toBe(true);

    const abortedAgain = responseRecorder();
    await routes.abortMultipart(
      request({
        method: 'POST',
        url: '/api/core/dataset/file/abortMultipart',
        body: { fileId: presignData.fileId, uploadId: 'upload-session-1' },
      }),
      abortedAgain.response,
    );
    expect(abortedAgain.result().status).toBe(200);
    expect((abortedAgain.result().body.data as { aborted: boolean }).aborted).toBe(true);
  });

  it('rejects a tampered or cross-team token with 501061', async () => {
    const routes = await importRoutes();
    const presigned = responseRecorder();
    await routes.presignUpload(
      request({
        method: 'POST',
        url: '/api/core/dataset/file/presignUpload',
        body: { datasetId: DATASET_ID, filename: 'a.md', size: 1, mime: 'text/markdown' },
      }),
      presigned.response,
    );
    const fileId = (presigned.result().body.data as { fileId: string }).fileId;
    const tampered = fileId.slice(0, -2) + (fileId.endsWith('aa') ? 'bb' : 'aa');
    const rejected = responseRecorder();
    await routes.uploadPart(
      request({
        method: 'POST',
        url: '/api/core/dataset/file/uploadPart',
        query: { fileId: tampered },
        body: { uploadId: 'u', partNumber: 1, chunk: new Uint8Array([1]), checksum: 'x' },
      }),
      rejected.response,
    );
    expect(rejected.result().body.code).toBe(501061);
  });

  it('previews chunks without creating any formal object (ACC-FLOW-PREVIEW-001)', async () => {
    const routes = await importRoutes();
    const presigned = responseRecorder();
    await routes.presignUpload(
      request({
        method: 'POST',
        url: '/api/core/dataset/file/presignUpload',
        body: { datasetId: DATASET_ID, filename: 'notes.md', size: 42, mime: 'text/markdown' },
      }),
      presigned.response,
    );
    const fileId = (presigned.result().body.data as { fileId: string }).fileId;
    const preview = responseRecorder();
    await routes.previewChunks(
      request({
        method: 'POST',
        url: '/api/core/dataset/file/previewChunks',
        body: { fileRef: fileId, chunkPolicy },
      }),
      preview.response,
    );
    expect(preview.result().status).toBe(200);
    const chunks = (preview.result().body.data as { chunks: unknown[] }).chunks;
    expect(Array.isArray(chunks)).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
  });
});

describe('TEST-TEMPKEY-001 search-test image temp keys', () => {
  it('issues an isolated temp key and returns preview URLs (ACC-IMAGE-003/004)', async () => {
    const routes = await importRoutes();
    const presigned = responseRecorder();
    await routes.presignSearchTestImage(
      request({
        method: 'POST',
        url: '/api/core/dataset/file/presignSearchTestImage',
        body: { filename: 'shot.png', size: 10, mime: 'image/png' },
      }),
      presigned.response,
    );
    expect(presigned.result().status).toBe(200);
    const data = presigned.result().body.data as { url: string; key: string; expiresAt: string };
    expect(data.key.startsWith(`temp/${TEAM_ID}/`)).toBe(true);

    const preview = responseRecorder();
    await routes.getSearchTestImagePreviewUrls(
      request({
        method: 'POST',
        url: '/api/core/dataset/file/getSearchTestImagePreviewUrls',
        body: { keys: [data.key] },
      }),
      preview.response,
    );
    expect(preview.result().status).toBe(200);
    const urls = (preview.result().body.data as { previewUrls: string[] }).previewUrls;
    expect(urls[0]?.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('rejects cross-team keys (501061) and expired keys (501011)', async () => {
    const routes = await importRoutes();
    const crossTeam = responseRecorder();
    await routes.getSearchTestImagePreviewUrls(
      request({
        method: 'POST',
        url: '/api/core/dataset/file/getSearchTestImagePreviewUrls',
        body: { keys: [`temp/${OTHER_TEAM_ID}/${Date.now() + 60_000}/a.png`] },
      }),
      crossTeam.response,
    );
    expect(crossTeam.result().body.code).toBe(501061);

    const expired = responseRecorder();
    await routes.getSearchTestImagePreviewUrls(
      request({
        method: 'POST',
        url: '/api/core/dataset/file/getSearchTestImagePreviewUrls',
        body: { keys: [`temp/${TEAM_ID}/1/a.png`] },
      }),
      expired.response,
    );
    expect(expired.result().body.code).toBe(501011);
  });
});
