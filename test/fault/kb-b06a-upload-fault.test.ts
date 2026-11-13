import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKnowledgeError } from '../../packages/contracts/src/errors/knowledge-errors';
import { createB06aEnv, errorCode, uploadBuffer, type B06aEnv } from '../fixtures/b06a/support';

let env: B06aEnv;

beforeAll(async () => {
  env = await createB06aEnv('fault');
}, 60_000);

afterAll(async () => {
  if (env) await env.cleanup();
}, 60_000);

type AnyStore = Record<string, (...args: never[]) => unknown>;

function patch(method: string, replacement: (...args: never[]) => unknown): () => void {
  const store = env.store as unknown as AnyStore;
  const had = Object.prototype.hasOwnProperty.call(store, method);
  const previous = store[method];
  store[method] = replacement;
  return () => {
    if (had) store[method] = previous;
    else delete store[method];
  };
}

describe('L1-B06-FILE-001-F01 provider failures', () => {
  it('L1-B06-FILE-001-F01 S3 超时进入幂等补偿且重试终态一致', async () => {
    const uploaded = await uploadBuffer(env, {
      name: 'timeout.txt',
      mimeType: 'text/plain',
      body: Buffer.from('timeout compensation body'),
      complete: false,
    });
    const original = env.store.copyObjectImmutable.bind(env.store) as never;
    let attempts = 0;
    const restore = patch('copyObjectImmutable', ((...args: never[]) => {
      attempts += 1;
      if (attempts === 1) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
          requestId: env.context.requestId,
          traceId: env.context.traceId,
          details: { operation: 'copyObjectImmutable' },
        });
      }
      return (original as (...inner: never[]) => unknown)(...args);
    }) as never);
    try {
      const session = await env.files.get(uploaded.uploadId, env.context);
      const failed = await env.files
        .complete({ uploadId: uploaded.uploadId, parts: session.parts }, env.context)
        .catch((error: unknown) => error);
      expect(errorCode(failed)).toBe('KNOWLEDGE_DEPENDENCY_TIMEOUT');
      const mid = await env.repository.findObjectRef(uploaded.uploadId, env.context);
      expect(mid?.state).not.toBe('active');
      expect(attempts).toBe(1);
    } finally {
      restore();
    }
    const recovered = await env.files.complete(
      { uploadId: uploaded.uploadId, parts: [] },
      env.context,
    );
    expect(recovered.state).toBe('active');
    const head = await env.store.headObject(
      env.store.bucket,
      recovered.objectKey,
      env.storageContext(),
    );
    expect(head.size).toBe(recovered.sizeBytes);
  });

  it('L1-B06-FILE-001-F01 原始 provider 异常映射为稳定 KNOWLEDGE_* 错误且不暴露堆栈', async () => {
    const uploaded = await uploadBuffer(env, {
      name: 'raw-failure.txt',
      mimeType: 'text/plain',
      body: Buffer.from('raw failure body'),
      complete: false,
    });
    const restore = patch('copyObjectImmutable', (() => {
      throw new Error('socket hang up at 10.0.0.9:9000 secret=minioadmin');
    }) as never);
    try {
      const failed = await env.files
        .complete({ uploadId: uploaded.uploadId, parts: [] }, env.context)
        .catch((error: unknown) => error);
      expect(errorCode(failed)).toBe('KNOWLEDGE_DEPENDENCY_UNAVAILABLE');
      const serialized = JSON.stringify((failed as { problem: unknown }).problem);
      expect(serialized).not.toContain('minioadmin');
      expect(serialized).not.toContain('10.0.0.9');
      expect(serialized).not.toContain('socket hang up');
    } finally {
      restore();
    }
    const recovered = await env.files.complete(
      { uploadId: uploaded.uploadId, parts: [] },
      env.context,
    );
    expect(recovered.state).toBe('active');
  });

  it('L1-B06-FILE-001-F01 不可变最终 key 已存在且内容不同时拒绝且不覆盖', async () => {
    const uploaded = await uploadBuffer(env, {
      name: 'immutable-conflict.txt',
      mimeType: 'text/plain',
      body: Buffer.from('immutable conflict body'),
      complete: false,
    });
    const finalKey = uploaded.ref.finalObjectKey;
    expect(finalKey).not.toBeNull();
    const foreign = Buffer.from('foreign different content');
    await env.store.putObject(
      {
        key: finalKey!,
        body: foreign,
        sizeBytes: foreign.byteLength,
        contentType: 'text/plain',
        metadata: { sha256: createHash('sha256').update(foreign).digest('hex') },
        workspaceId: env.workspaceId,
        knowledgeSpaceId: env.spaceId,
      },
      env.storageContext(),
    );
    const failed = await env.files
      .complete({ uploadId: uploaded.uploadId, parts: [] }, env.context)
      .catch((error: unknown) => error);
    expect(errorCode(failed)).toBe('KNOWLEDGE_CONFLICT');
    const head = await env.store.headObject(env.store.bucket, finalKey!, env.storageContext());
    expect(head.size).toBe(foreign.byteLength);
    const mid = await env.repository.findObjectRef(uploaded.uploadId, env.context);
    expect(mid?.state).not.toBe('active');
  });

  it('L1-B06-FILE-001-F01 provider 404 不产生活动对象且恢复后可完成', async () => {
    const uploaded = await uploadBuffer(env, {
      name: 'provider-404.txt',
      mimeType: 'text/plain',
      body: Buffer.from('provider 404 body'),
      complete: false,
    });
    const original = env.store.headObject.bind(env.store) as never;
    const restore = patch('headObject', ((...args: never[]) => {
      const key = args[1] as unknown as string;
      if (key === uploaded.ref.objectKey) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_NOT_FOUND',
          requestId: env.context.requestId,
          traceId: env.context.traceId,
          details: { operation: 'headObject' },
        });
      }
      return (original as (...inner: never[]) => unknown)(...args);
    }) as never);
    try {
      const failed = await env.files
        .complete({ uploadId: uploaded.uploadId, parts: [] }, env.context)
        .catch((error: unknown) => error);
      expect(errorCode(failed)).toBe('KNOWLEDGE_NOT_FOUND');
      const mid = await env.repository.findObjectRef(uploaded.uploadId, env.context);
      expect(mid?.state).not.toBe('active');
    } finally {
      restore();
    }
    const recovered = await env.files.complete(
      { uploadId: uploaded.uploadId, parts: [] },
      env.context,
    );
    expect(recovered.state).toBe('active');
  });
});
