import { describe, expect, it } from 'vitest';
import type {
  KnowledgeObjectContext,
  ObjectStoreConfig,
} from '../../sdk/storage/src/object-store-contract';
import {
  mapObjectStoreError,
  providerContractError,
} from '../../sdk/storage/src/object-store-contract';
import { createKnowledgeObjectStore } from '../../sdk/storage/src/provider-factory';

const context: KnowledgeObjectContext = {
  workspaceId: 'ws_contract',
  knowledgeSpaceId: 'space_contract',
  requestId: 'request-contract',
  traceId: 'trace-contract',
};

const cloudConfig = (
  provider: Exclude<ObjectStoreConfig['provider'], 'minio'>,
): ObjectStoreConfig => ({
  provider,
  endpoint: 'https://storage.example.invalid',
  region: provider === 'r2' ? 'auto' : 'us-east-1',
  bucket: 'contract-bucket',
  credentials: {
    accessKeyId: 'contract-access-key',
    secretAccessKey: 'contract-secret-key',
  },
  credentialRefs: ['secret:contract-access', 'secret:contract-secret'],
});

function capture(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('expected action to throw');
}

describe('TEST-FILE-002-BLOCK provider contract', () => {
  it('constructs MinIO, AWS S3, R2, COS and OSS from discriminated configs', () => {
    const providers = [
      createKnowledgeObjectStore({
        provider: 'minio',
        endPoint: 'localhost',
        port: 9000,
        useSSL: false,
        accessKey: 'access',
        secretKey: 'secret',
        region: 'us-east-1',
        bucket: 'contract-bucket',
        credentialRefs: ['env:ACCESS', 'env:SECRET'],
      }),
      ...(['aws-s3', 'r2', 'cos', 'oss'] as const).map((provider) =>
        createKnowledgeObjectStore(cloudConfig(provider)),
      ),
    ];
    expect(providers.map((provider) => provider.provider)).toEqual([
      'minio',
      'aws-s3',
      'r2',
      'cos',
      'oss',
    ]);
    expect(
      providers.slice(1).every((provider) => provider.verificationStatus === 'EXTERNAL_UNVERIFIED'),
    ).toBe(true);
  });

  it('TEST-FILE-002-P01 rejects missing endpoint, region, bucket or secret ref', () => {
    const error = capture(() =>
      createKnowledgeObjectStore({
        ...cloudConfig('aws-s3'),
        endpoint: '',
        region: '',
        bucket: '',
        credentialRefs: [],
      }),
    );
    expect(error).toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_VALIDATION_FAILED',
          details: { missingFields: expect.any(Array) },
        },
      },
    });
  });

  it('TEST-FILE-002-P02 maps provider 404 to KNOWLEDGE_NOT_FOUND', () => {
    const error = capture(() =>
      mapObjectStoreError({ statusCode: 404 }, 'minio', 'headObject', context),
    );
    expect(error).toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });
  });

  it('TEST-FILE-002-P03 maps provider 403 without leaking the key', () => {
    const error = capture(() =>
      mapObjectStoreError(
        { statusCode: 403 },
        'aws-s3',
        'headObject',
        context,
        'ws/ws_contract/space/space_contract/source/source/file/blob/file.txt',
      ),
    );
    expect(error).toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE' } },
    });
    expect(JSON.stringify(error)).not.toContain('/source/source/');
  });

  it('TEST-FILE-002-P04 maps provider timeouts to KNOWLEDGE_DEPENDENCY_TIMEOUT', () => {
    const error = capture(() =>
      mapObjectStoreError({ code: 'TimeoutError' }, 'r2', 'getObject', context),
    );
    expect(error).toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_DEPENDENCY_TIMEOUT' } },
    });
  });

  it('TEST-FILE-002-P05 maps missing etag or size to provider contract invalid', () => {
    const error = capture(() => {
      throw providerContractError('cos', 'headObject', context);
    });
    expect(error).toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID' } },
    });
  });
});
