import { describe, expect, it } from 'vitest';
import type { KnowledgeObjectContext } from '../../src/object-store-contract';
import {
  assertKnowledgeObjectKey,
  knowledgeObjectKey,
  mapObjectStoreError,
  parseSingleRange,
  providerContractError,
  type ObjectStoreConfig,
} from '../../src/object-store-contract';
import { createKnowledgeObjectStore, validateObjectStoreConfig } from '../../src/provider-factory';

const context: KnowledgeObjectContext = {
  workspaceId: 'ws_unit',
  knowledgeSpaceId: 'space_unit',
  requestId: 'request-unit',
  traceId: 'trace-unit',
};

const cloudConfig = (
  provider: Exclude<ObjectStoreConfig['provider'], 'minio'>,
): ObjectStoreConfig => ({
  provider,
  endpoint: 'https://storage.example.invalid',
  region: provider === 'r2' ? 'auto' : 'us-east-1',
  bucket: 'unit-bucket',
  credentials: {
    accessKeyId: 'unit-access-key',
    secretAccessKey: 'unit-secret-key',
  },
  credentialRefs: ['secret:unit-access', 'secret:unit-secret'],
});

describe('knowledge object store contract', () => {
  it('builds all five provider variants with the expected verification status', () => {
    const minio = createKnowledgeObjectStore({
      provider: 'minio',
      endPoint: 'localhost',
      port: 9000,
      useSSL: false,
      accessKey: 'minio',
      secretKey: 'minio-secret',
      region: 'us-east-1',
      bucket: 'unit-bucket',
      credentialRefs: ['env:MINIO_ROOT_USER', 'env:MINIO_ROOT_PASSWORD'],
    });
    expect(minio.provider).toBe('minio');
    expect(minio.verificationStatus).toBe('REAL_VERIFIED');

    for (const provider of ['aws-s3', 'r2', 'cos', 'oss'] as const) {
      const store = createKnowledgeObjectStore(cloudConfig(provider));
      expect(store.provider).toBe(provider);
      expect(store.verificationStatus).toBe('EXTERNAL_UNVERIFIED');
    }
  });

  it('rejects missing provider configuration fields', () => {
    expect(() =>
      validateObjectStoreConfig({
        ...cloudConfig('aws-s3'),
        endpoint: '',
        region: '',
        credentialRefs: [],
      }),
    ).toThrowError(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({ code: 'KNOWLEDGE_VALIDATION_FAILED' }),
        }),
      }),
    );
  });

  it('rejects absolute, parent and cross-workspace keys', () => {
    expect(() => assertKnowledgeObjectKey('/etc/passwd', context)).toThrow();
    expect(() => assertKnowledgeObjectKey('ws/ws_unit/space/space_unit/../x', context)).toThrow();
    expect(() => assertKnowledgeObjectKey('ws/other/space/space_unit/source/a', context)).toThrow();
  });

  it('accepts exact single ranges and rejects unsatisfied ranges', () => {
    expect(parseSingleRange('bytes=10-19', 20, context)).toEqual({
      start: 10,
      end: 19,
      header: 'bytes=10-19',
    });
    expect(() => parseSingleRange('bytes=10-20', 20, context)).toThrowError(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({ code: 'KNOWLEDGE_RANGE_NOT_SATISFIABLE' }),
        }),
      }),
    );
  });

  it('sanitizes provider errors without exposing keys or secrets', () => {
    const key = knowledgeObjectKey({
      workspaceId: context.workspaceId,
      knowledgeSpaceId: context.knowledgeSpaceId,
      sourceId: 'source_unit',
      purpose: 'source',
      blobId: 'blob_unit',
      safeName: 'secret-do-not-log.txt',
    });
    let caught: unknown;
    try {
      mapObjectStoreError(
        { statusCode: 403, message: 'secret-do-not-log' },
        'aws-s3',
        'headObject',
        context,
        key,
      );
    } catch (error) {
      caught = error;
    }
    const serialized = JSON.stringify(caught);
    expect(serialized).toContain('KNOWLEDGE_DEPENDENCY_UNAVAILABLE');
    expect(serialized).not.toContain(key);
    expect(serialized).not.toContain('secret-do-not-log');
  });

  it('maps provider timeouts and invalid responses to the canonical errors', () => {
    expect(() =>
      mapObjectStoreError({ code: 'ETIMEDOUT' }, 'oss', 'getObject', context),
    ).toThrowError(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({ code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT' }),
        }),
      }),
    );
    expect(() => {
      throw providerContractError('cos', 'headObject', context);
    }).toThrowError(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({ code: 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID' }),
        }),
      }),
    );
  });
});
