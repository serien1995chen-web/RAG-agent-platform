import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectLifecycleService } from '../../packages/service/src/modules/knowledge/application/object-lifecycle';
import { createB06aEnv, errorCode, uploadBuffer, type B06aEnv } from '../fixtures/b06a/support';

let env: B06aEnv;
let lifecycle: ObjectLifecycleService;

beforeAll(async () => {
  env = await createB06aEnv('concurrency');
  lifecycle = new ObjectLifecycleService(env.repository, env.store, 500);
}, 60_000);

afterAll(async () => {
  if (env) await env.cleanup();
}, 60_000);

async function expire(uploadId: string) {
  await env.connection.models.KnowledgeObjectRef.updateOne(
    { _id: uploadId },
    { $set: { expiresAt: new Date(Date.now() - 1_000) } },
  );
}

describe('TEST-X-UPLOAD-MULTIPART complete and abort', () => {
  it('L1-B06-FILE-001-C01 complete 与 abort 并发仅一个最终状态', async () => {
    const uploaded = await uploadBuffer(env, {
      name: 'race-single.txt',
      mimeType: 'text/plain',
      body: Buffer.from('race single body'),
    });
    const session = await env.files.get(uploaded.uploadId, env.context);
    const results = await Promise.allSettled([
      env.files.complete({ uploadId: uploaded.uploadId, parts: [] }, env.context),
      env.files.abort(uploaded.uploadId, session.version, env.context),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const final = await env.files.get(uploaded.uploadId, env.context);
    expect(['completed', 'aborted']).toContain(final.status);
    const head = await env.store
      .headObject(
        env.store.bucket,
        uploaded.ref.finalObjectKey ?? uploaded.ref.objectKey,
        env.storageContext(),
      )
      .catch((error: unknown) => error);
    if (final.status === 'aborted') {
      expect(errorCode(head)).toBe('KNOWLEDGE_NOT_FOUND');
    } else {
      expect((head as { size: number }).size).toBe('race single body'.length);
    }
  });

  it('L1-B06-FILE-001-C01 重复 complete 不生成第二份对象事实', async () => {
    const uploaded = await uploadBuffer(env, {
      name: 'repeat-complete.txt',
      mimeType: 'text/plain',
      body: Buffer.from('repeat complete body'),
    });
    const [first, second] = await Promise.all([
      env.files.complete({ uploadId: uploaded.uploadId, parts: [] }, env.context),
      env.files.complete({ uploadId: uploaded.uploadId, parts: [] }, env.context),
    ]);
    expect(second.blobId).toBe(first.blobId);
    expect(second.etag).toBe(first.etag);
    expect(second.objectKey).toBe(first.objectKey);
    expect(
      await env.connection.models.KnowledgeObjectRef.countDocuments({
        workspaceId: env.workspaceId,
        sourceId: { $ne: null },
        'upload.originalName': 'repeat-complete.txt',
      }),
    ).toBe(0);
    expect(
      await env.connection.models.KnowledgeObjectRef.countDocuments({
        workspaceId: env.workspaceId,
        _id: uploaded.uploadId,
      }),
    ).toBe(1);
  });

  it('TEST-X-UPLOAD-MULTIPART multipart complete/abort 竞争单成功', async () => {
    const body = Buffer.alloc(8 * 1024 * 1024 + 11, 0x63);
    const uploaded = await uploadBuffer(env, {
      name: 'race-multipart.txt',
      mimeType: 'text/plain',
      body,
      complete: false,
    });
    const session = await env.files.get(uploaded.uploadId, env.context);
    expect(session.status).toBe('uploading');
    const results = await Promise.allSettled([
      env.files.complete({ uploadId: uploaded.uploadId, parts: session.parts }, env.context),
      env.files.abort(uploaded.uploadId, session.version, env.context),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const final = await env.files.get(uploaded.uploadId, env.context);
    expect(['completed', 'aborted']).toContain(final.status);
    expect(
      await env.connection.models.KnowledgeObjectRef.countDocuments({
        workspaceId: env.workspaceId,
        _id: uploaded.uploadId,
      }),
    ).toBe(1);
  });

  it('TEST-X-UPLOAD-MULTIPART 过期临时对象按 TTL 收敛且活动对象保留', async () => {
    const pending = await env.files.init(
      {
        knowledgeSpaceId: env.spaceId,
        name: 'ttl-pending.txt',
        mimeType: 'text/plain',
        sizeBytes: 4,
      },
      env.context,
    );
    const pendingRef = await env.repository.findObjectRef(pending.uploadId, env.context);
    env.track(pendingRef);
    const presigned = await env.files.presign(pending.uploadId, { partNumbers: [1] }, env.context);
    await fetch(presigned.uploads[0]!.url, {
      method: 'PUT',
      headers: presigned.uploads[0]!.headers,
      body: Buffer.from('ttl pending body'),
    });

    const active = await uploadBuffer(env, {
      name: 'ttl-active.txt',
      mimeType: 'text/plain',
      body: Buffer.from('active body'),
    });

    await expire(pending.uploadId);
    const cleanup = await lifecycle.cleanup(env.context, new Date(), 'ttl_objects');
    expect(cleanup.deleted + cleanup.failed).toBeGreaterThanOrEqual(1);

    const pendingRefAfter = await env.repository.findObjectRef(pending.uploadId, env.context);
    expect(pendingRefAfter?.state).toBe('deleted');
    const pendingHead = await env.store
      .headObject(env.store.bucket, pendingRef!.objectKey, env.storageContext())
      .catch((error: unknown) => error);
    expect(errorCode(pendingHead)).toBe('KNOWLEDGE_NOT_FOUND');
    const pendingAfter = await env.files.get(pending.uploadId, env.context);
    expect(pendingAfter.status).toBe('expired');

    const activeAfter = await env.repository.findObjectRef(active.uploadId, env.context);
    expect(activeAfter?.state).toBe('active');
    const activeHead = await env.store.headObject(
      env.store.bucket,
      activeAfter!.objectKey,
      env.storageContext(),
    );
    expect(activeHead.size).toBe('active body'.length);
  });
});
