import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createB06aEnv, errorCode, uploadBuffer, type B06aEnv } from '../fixtures/b06a/support';

const fixtureRoot = resolve(import.meta.dirname, '..', 'fixtures', 's11', 'generated');
let env: B06aEnv;

beforeAll(async () => {
  env = await createB06aEnv('security');
}, 60_000);

afterAll(async () => {
  if (env) await env.cleanup();
}, 60_000);

async function rejectedUpload(input: {
  name: string;
  mimeType: string;
  body: Buffer;
}): Promise<{ code: string; objectKey: string; deleted: boolean; status: string | null }> {
  const uploaded = await uploadBuffer(env, { ...input, complete: false });
  const failed = await env.files
    .complete({ uploadId: uploaded.uploadId, parts: [] }, env.context)
    .catch((error: unknown) => error);
  const code = errorCode(failed);
  const session = await env.repository.findUploadSession(uploaded.uploadId, env.context);
  const head = await env.store
    .headObject(env.store.bucket, uploaded.ref.objectKey, env.storageContext())
    .catch((error: unknown) => error);
  return {
    code,
    objectKey: uploaded.ref.objectKey,
    deleted: errorCode(head) === 'KNOWLEDGE_NOT_FOUND',
    status: session?.status ?? null,
  };
}

describe('TEST-X-SECURITY-UPLOAD upload entry', () => {
  it('L1-B06-FILE-001-Q01 声明 MIME 与内容不符时拒绝并删除临时对象', async () => {
    const pdfSpoof = await rejectedUpload({
      name: 'spoof.pdf',
      mimeType: 'application/pdf',
      body: Buffer.from('this is not a pdf at all'),
    });
    expect(pdfSpoof.code).toBe('KNOWLEDGE_UNSUPPORTED_CONTENT');
    expect(pdfSpoof.deleted).toBe(true);
    expect(pdfSpoof.status).toBe('aborted');

    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const tiffSpoof = await rejectedUpload({
      name: 'spoof.tif',
      mimeType: 'image/tiff',
      body: pngBytes,
    });
    expect(tiffSpoof.code).toBe('KNOWLEDGE_UNSUPPORTED_CONTENT');
    expect(tiffSpoof.deleted).toBe(true);

    const zipSpoof = await rejectedUpload({
      name: 'spoof.zip',
      mimeType: 'application/zip',
      body: Buffer.from('plain text pretending to be a zip'),
    });
    expect(zipSpoof.code).toBe('KNOWLEDGE_UNSUPPORTED_CONTENT');
    expect(zipSpoof.deleted).toBe(true);
  });

  it('L1-B06-FILE-001-Q01 双扩展名与非法扩展名在上传入口被拒绝', async () => {
    const baseline = await env.connection.models.KnowledgeObjectRef.countDocuments({
      workspaceId: env.workspaceId,
    });
    const doubleExtension = await env.files
      .init(
        {
          knowledgeSpaceId: env.spaceId,
          name: 'report.pdf.exe',
          mimeType: 'application/pdf',
          sizeBytes: 10,
        },
        env.context,
      )
      .catch((error: unknown) => error);
    expect(errorCode(doubleExtension)).toBe('KNOWLEDGE_UNSUPPORTED_CONTENT');

    const executable = await env.files
      .init(
        {
          knowledgeSpaceId: env.spaceId,
          name: 'payload.exe',
          mimeType: 'application/octet-stream',
          sizeBytes: 10,
        },
        env.context,
      )
      .catch((error: unknown) => error);
    expect(errorCode(executable)).toBe('KNOWLEDGE_UNSUPPORTED_CONTENT');

    const mismatch = await env.files
      .init(
        {
          knowledgeSpaceId: env.spaceId,
          name: 'report.pdf',
          mimeType: 'text/plain',
          sizeBytes: 10,
        },
        env.context,
      )
      .catch((error: unknown) => error);
    expect(errorCode(mismatch)).toBe('KNOWLEDGE_UNSUPPORTED_CONTENT');

    expect(
      await env.connection.models.KnowledgeObjectRef.countDocuments({
        workspaceId: env.workspaceId,
      }),
    ).toBe(baseline);
  });

  it('L1-B06-FILE-001-Q01 ZIP 压缩炸弹与 zip-slip 样本被拒绝且不标记 active', async () => {
    const bomb = await readFile(resolve(fixtureRoot, 's11-zip-bomb.zip'));
    const bombResult = await rejectedUpload({
      name: 'bomb.zip',
      mimeType: 'application/zip',
      body: bomb,
    });
    expect(['KNOWLEDGE_UNSUPPORTED_CONTENT', 'KNOWLEDGE_PAYLOAD_TOO_LARGE']).toContain(
      bombResult.code,
    );
    expect(bombResult.deleted).toBe(true);
    expect(['aborted', 'expired']).toContain(bombResult.status);

    const slip = await readFile(resolve(fixtureRoot, 's11-zip-slip.zip'));
    const slipResult = await rejectedUpload({
      name: 'slip.zip',
      mimeType: 'application/zip',
      body: slip,
    });
    expect(['KNOWLEDGE_UNSUPPORTED_CONTENT', 'KNOWLEDGE_PAYLOAD_TOO_LARGE']).toContain(
      slipResult.code,
    );
    expect(slipResult.deleted).toBe(true);
  });

  it('L1-B06-FILE-001-Q01 大小、分片数与零字节分片限制生效且不产生活动对象', async () => {
    const tooLarge = await env.files
      .init(
        {
          knowledgeSpaceId: env.spaceId,
          name: 'huge.bin.txt',
          mimeType: 'text/plain',
          sizeBytes: 1000 * 1024 * 1024 + 1,
        },
        env.context,
      )
      .catch((error: unknown) => error);
    expect(errorCode(tooLarge)).toBe('KNOWLEDGE_PAYLOAD_TOO_LARGE');

    const atLimit = await env.files.init(
      {
        knowledgeSpaceId: env.spaceId,
        name: 'parts.txt',
        mimeType: 'text/plain',
        sizeBytes: 1000 * 1024 * 1024,
      },
      env.context,
    );
    expect(atLimit.mode).toBe('multipart');
    expect(atLimit.partCount).toBe(125);
    expect(atLimit.partCount).toBeLessThanOrEqual(10_000);
    await env.files.abort(atLimit.uploadId, atLimit.version, env.context);

    const session = await env.files.init(
      {
        knowledgeSpaceId: env.spaceId,
        name: 'zero-part.txt',
        mimeType: 'text/plain',
        sizeBytes: 8 * 1024 * 1024 + 1,
      },
      env.context,
    );
    const ref = await env.repository.findObjectRef(session.uploadId, env.context);
    env.track(ref);
    const zero = await env.files
      .uploadPart(session.uploadId, 1, Buffer.alloc(0), env.context)
      .catch((error: unknown) => error);
    expect(errorCode(zero)).toBe('KNOWLEDGE_PAYLOAD_TOO_LARGE');
    const oversized = await env.files
      .uploadPart(session.uploadId, 1, Buffer.alloc(8 * 1024 * 1024 + 1), env.context)
      .catch((error: unknown) => error);
    expect(errorCode(oversized)).toBe('KNOWLEDGE_PAYLOAD_TOO_LARGE');
    const outOfRange = await env.files
      .uploadPart(session.uploadId, 10_001, Buffer.alloc(1), env.context)
      .catch((error: unknown) => error);
    expect(errorCode(outOfRange)).toBe('KNOWLEDGE_PAYLOAD_TOO_LARGE');
    await env.files.abort(session.uploadId, session.version, env.context);
  });

  it('L1-B06-FILE-001-Q01 非法 object key 无法写入对象存储', async () => {
    const illegal = await env.store
      .putObject(
        {
          key: 'ws/' + env.workspaceId + '/space/' + env.spaceId + '/../escape.txt',
          body: Buffer.from('escape'),
          sizeBytes: 6,
          contentType: 'text/plain',
          workspaceId: env.workspaceId,
          knowledgeSpaceId: env.spaceId,
        },
        env.storageContext(),
      )
      .catch((error: unknown) => error);
    expect(errorCode(illegal)).toBe('KNOWLEDGE_NOT_FOUND');

    const foreignPrefix = await env.store
      .putObject(
        {
          key: 'ws/other-workspace/space/' + env.spaceId + '/foreign.txt',
          body: Buffer.from('foreign'),
          sizeBytes: 7,
          contentType: 'text/plain',
          workspaceId: env.workspaceId,
          knowledgeSpaceId: env.spaceId,
        },
        env.storageContext(),
      )
      .catch((error: unknown) => error);
    expect(errorCode(foreignPrefix)).toBe('KNOWLEDGE_NOT_FOUND');
  });
});
