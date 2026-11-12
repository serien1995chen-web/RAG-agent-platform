import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createB06aEnv, errorCode, uploadBuffer, type B06aEnv } from '../fixtures/b06a/support';

let env: B06aEnv;

beforeAll(async () => {
  env = await createB06aEnv('tenant');
}, 60_000);

afterAll(async () => {
  if (env) await env.cleanup();
}, 60_000);

describe('TEST-X-TENANT-GUARD upload tenant isolation', () => {
  it('L1-B06-FILE-001-A01 跨租户 uploadId、objectKey 与预签名 key 均被拒绝且错误不泄露内部信息', async () => {
    const uploaded = await uploadBuffer(env, {
      name: 'tenant-upload.txt',
      mimeType: 'text/plain',
      body: Buffer.from('tenant isolation body'),
    });

    expect(await env.repository.findUploadSession(uploaded.uploadId, env.otherContext)).toBeNull();
    expect(await env.repository.findObjectRef(uploaded.uploadId, env.otherContext)).toBeNull();

    const others = await Promise.all([
      env.files.get(uploaded.uploadId, env.otherContext).catch((error: unknown) => error),
      env.files
        .presign(uploaded.uploadId, { partNumbers: [1] }, env.otherContext)
        .catch((error: unknown) => error),
      env.files
        .complete({ uploadId: uploaded.uploadId, parts: [] }, env.otherContext)
        .catch((error: unknown) => error),
      env.files.abort(uploaded.uploadId, 1, env.otherContext).catch((error: unknown) => error),
    ]);
    for (const error of others) {
      expect(errorCode(error)).toBe('KNOWLEDGE_NOT_FOUND');
      expect(JSON.stringify((error as { problem: unknown }).problem)).not.toContain(
        uploaded.ref.objectKey,
      );
      expect(JSON.stringify((error as { problem: unknown }).problem)).not.toContain(
        env.store.bucket,
      );
    }

    expect(uploaded.ref.objectKey.startsWith('ws/' + env.workspaceId + '/')).toBe(true);
    expect(uploaded.ref.objectKey).not.toContain(env.otherWorkspaceId);
    expect(uploaded.ref.finalObjectKey ?? '').not.toContain(env.otherWorkspaceId);

    const session = await env.files.init(
      {
        knowledgeSpaceId: env.spaceId,
        name: 'tenant-presign.txt',
        mimeType: 'text/plain',
        sizeBytes: 8,
      },
      env.context,
    );
    const pending = await env.repository.findObjectRef(session.uploadId, env.context);
    env.track(pending);
    const presigned = await env.files.presign(session.uploadId, { partNumbers: [1] }, env.context);
    const url = presigned.uploads[0]!.url;
    expect(url).toContain('/ws/' + env.workspaceId + '/');
    expect(url).not.toContain(env.otherWorkspaceId);
    expect(url).not.toContain('X-Amz-Security-Token');
    await env.files.abort(session.uploadId, session.version, env.context);
  });

  it('TEST-X-TENANT-GUARD 跨租户预览与下载 ticket 不返回对象内容', async () => {
    const uploaded = await uploadBuffer(env, {
      name: 'tenant-ticket.txt',
      mimeType: 'text/plain',
      body: Buffer.from('tenant ticket body'),
    });
    const source = await env.connection.models.KnowledgeSource.create({
      workspaceId: env.workspaceId,
      knowledgeSpaceId: env.spaceId,
      kind: 'file',
      name: 'tenant-ticket.txt',
      mimeType: 'text/plain',
      sizeBytes: 'tenant ticket body'.length,
      contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      parseProvider: 'liteparse',
      processingStatus: 'ready',
      sourceVersion: 1,
      searchEnabled: true,
      permissionState: 'inherited',
      ownershipMemberId: env.memberId,
      createdByMemberId: env.memberId,
      updatedByMemberId: env.memberId,
    });
    await env.connection.models.KnowledgeObjectRef.updateOne(
      { _id: uploaded.uploadId },
      { $set: { sourceId: source._id } },
    );

    const preview = await env.files
      .preview(uploaded.uploadId, { ttlSeconds: 300 }, env.otherContext)
      .catch((error: unknown) => error);
    expect(errorCode(preview)).toBe('KNOWLEDGE_NOT_FOUND');
    const download = await env.files
      .download(uploaded.uploadId, { ttlSeconds: 60 }, env.otherContext)
      .catch((error: unknown) => error);
    expect(errorCode(download)).toBe('KNOWLEDGE_NOT_FOUND');

    const ownTicket = await env.files.preview(uploaded.uploadId, { ttlSeconds: 300 }, env.context);
    expect(ownTicket.url).toContain('/v1/knowledge/files/');
    expect(ownTicket.url).not.toContain(uploaded.ref.objectKey);
    expect(ownTicket.url).not.toContain(env.store.bucket);

    const ticketValue = ownTicket.ticket;
    const crossRead = await env.files
      .content(uploaded.uploadId, null, ticketValue, env.otherContext)
      .catch((error: unknown) => error);
    expect(['KNOWLEDGE_FORBIDDEN', 'KNOWLEDGE_NOT_FOUND']).toContain(errorCode(crossRead));

    const missingContext = { ...env.context, workspaceId: '' };
    const missing = await env.repository
      .findUploadSession(uploaded.uploadId, missingContext)
      .catch((error: unknown) => error);
    expect(errorCode(missing)).toBe('KNOWLEDGE_VALIDATION_FAILED');

    const ownRead = await env.files.content(uploaded.uploadId, null, ticketValue, env.context);
    const chunks: Buffer[] = [];
    for await (const chunk of ownRead.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString('utf8')).toBe('tenant ticket body');
  });
});
