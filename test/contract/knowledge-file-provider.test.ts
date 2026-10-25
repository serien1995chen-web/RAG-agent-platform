import { describe, expect, it, vi } from 'vitest';
import type {
  KnowledgeObjectContext,
  ObjectStoreConfig,
  ObjectStorePort,
} from '../../sdk/storage/src/object-store-contract';
import {
  mapObjectCopyError,
  mapObjectStoreError,
  providerContractError,
} from '../../sdk/storage/src/object-store-contract';
import { createKnowledgeObjectStore } from '../../sdk/storage/src/provider-factory';
import {
  AWS_S3_MAX_SOCKETS,
  AwsS3KnowledgeObjectStore,
} from '../../sdk/storage/src/providers/aws-s3';
import { CosKnowledgeObjectStore } from '../../sdk/storage/src/providers/cos';
import { MinioKnowledgeObjectStore } from '../../sdk/storage/src/providers/minio';
import { OssKnowledgeObjectStore } from '../../sdk/storage/src/providers/oss';

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

const minioConfig: ObjectStoreConfig = {
  provider: 'minio',
  endPoint: 'localhost',
  port: 9000,
  useSSL: false,
  accessKey: 'access',
  secretKey: 'secret',
  region: 'us-east-1',
  bucket: 'contract-bucket',
  credentialRefs: ['env:ACCESS', 'env:SECRET'],
};

const copyInput = {
  sourceKey: 'ws/ws_contract/space/space_contract/source/unbound/pending/blob/file.txt',
  targetKey: 'ws/ws_contract/space/space_contract/source/unbound/source/blob/file.txt',
  expectedSourceEtag: 'source-etag',
  expectedSize: 5,
  contentType: 'text/plain',
  metadata: { sha256: 'abc123' },
};

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

  it('exposes the complete capability surface and bounded AWS request handler', () => {
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
    const methods = [
      'ensureBucket',
      'putObject',
      'headObject',
      'getObject',
      'presignPut',
      'presignGet',
      'createMultipartUpload',
      'uploadPart',
      'listParts',
      'completeMultipartUpload',
      'abortMultipartUpload',
      'deleteObject',
    ] as const;
    for (const provider of providers) {
      for (const method of methods) {
        expect(typeof provider[method], `${provider.provider}.${method}`).toBe('function');
      }
    }
    expect(AWS_S3_MAX_SOCKETS).toBe(50);
  });

  it('rejects cross-tenant keys in all five providers before network access', async () => {
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
    for (const provider of providers) {
      const error = await provider
        .headObject(
          provider.bucket,
          'ws/ws_other/space/space_contract/source/source/blob/file.txt',
          context,
        )
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        problem: {
          error: {
            code: 'KNOWLEDGE_NOT_FOUND',
          },
        },
      });
    }
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

  it('TEST-FILE-002-P10 / TEST-X-IMMUTABLE-UPLOAD copies through five providers with source ETag preconditions', async () => {
    const minioCopy = vi.fn(async (...args: unknown[]) => {
      const conditions = args[3] as { matchETag: string };
      expect(conditions.matchETag).toBe(copyInput.expectedSourceEtag);
      return { etag: 'target-etag', lastModified: new Date() };
    });
    const minio = new MinioKnowledgeObjectStore(
      minioConfig as never,
      {
        copyObject: minioCopy,
        statObject: vi.fn().mockResolvedValue({
          size: 5,
          etag: 'target-etag',
          metaData: { 'content-type': 'text/plain' },
        }),
      } as never,
    );

    const awsSend = vi.fn(async (command: { constructor: { name: string }; input: unknown }) => {
      if (command.constructor.name === 'CopyObjectCommand') {
        expect(command.input).toMatchObject({
          CopySourceIfMatch: copyInput.expectedSourceEtag,
          ContentType: copyInput.contentType,
        });
        return { CopyObjectResult: { ETag: '"target-etag"' } };
      }
      return {
        ContentLength: 5,
        ETag: '"target-etag"',
        ContentType: 'text/plain',
        Metadata: { sha256: 'abc123' },
      };
    });
    const aws = new AwsS3KnowledgeObjectStore(cloudConfig('aws-s3'), { send: awsSend } as never);
    const r2Send = vi.fn(async (command: { constructor: { name: string }; input: unknown }) => {
      if (command.constructor.name === 'CopyObjectCommand') {
        expect(command.input).toMatchObject({
          CopySourceIfMatch: copyInput.expectedSourceEtag,
        });
        return { CopyObjectResult: { ETag: '"target-etag"' } };
      }
      return {
        ContentLength: 5,
        ETag: '"target-etag"',
        ContentType: 'text/plain',
        Metadata: {},
      };
    });
    const r2 = new AwsS3KnowledgeObjectStore(cloudConfig('r2'), { send: r2Send } as never);

    const cosCopy = vi.fn(async (params: Record<string, unknown>) => {
      expect(params.CopySourceIfMatch).toBe(copyInput.expectedSourceEtag);
      return { ETag: 'target-etag' };
    });
    const cos = new CosKnowledgeObjectStore(cloudConfig('cos'), {
      putObjectCopy: cosCopy,
      headObject: vi.fn().mockResolvedValue({
        ETag: 'target-etag',
        headers: { 'content-length': '5', 'content-type': 'text/plain' },
      }),
    } as never);

    const ossCopy = vi.fn(async (...args: unknown[]) => {
      expect(args[3]).toMatchObject({
        headers: { 'x-oss-copy-source-if-match': copyInput.expectedSourceEtag },
      });
      return { etag: 'target-etag' };
    });
    const oss = new OssKnowledgeObjectStore(cloudConfig('oss'), {
      copy: ossCopy,
      head: vi.fn().mockResolvedValue({
        res: { headers: { 'content-length': '5', etag: '"target-etag"' } },
      }),
    } as never);

    const providers: ObjectStorePort[] = [minio, aws, r2, cos, oss];
    for (const provider of providers) {
      await expect(provider.copyObjectImmutable(copyInput, context)).resolves.toMatchObject({
        sourceEtag: 'source-etag',
        etag: 'target-etag',
        sizeBytes: 5,
      });
    }
    expect(minioCopy).toHaveBeenCalledTimes(1);
    expect(awsSend).toHaveBeenCalledTimes(2);
    expect(r2Send).toHaveBeenCalledTimes(2);
    expect(cosCopy).toHaveBeenCalledTimes(1);
    expect(ossCopy).toHaveBeenCalledTimes(1);
  });

  it('TEST-FILE-002-P11 maps copy preconditions to conflict and malformed evidence to contract invalid', async () => {
    const conflict = capture(() =>
      mapObjectCopyError({ statusCode: 412 }, 'aws-s3', context, [
        copyInput.sourceKey,
        copyInput.targetKey,
      ]),
    );
    expect(conflict).toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_CONFLICT' } },
    });
    expect(JSON.stringify(conflict)).not.toContain('/source/');

    const invalid = new MinioKnowledgeObjectStore(
      minioConfig as never,
      {
        copyObject: vi.fn().mockResolvedValue({ etag: '' }),
        statObject: vi.fn().mockResolvedValue({
          size: 4,
          etag: '',
          metaData: {},
        }),
      } as never,
    );
    const error = await invalid
      .copyObjectImmutable(copyInput, context)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID' } },
    });
  });

  it('TEST-FILE-002-P12 rejects cross-tenant copy source and target keys before network access', async () => {
    const copy = vi.fn();
    const providers: ObjectStorePort[] = [
      new MinioKnowledgeObjectStore(
        minioConfig as never,
        {
          copyObject: copy,
          statObject: vi.fn(),
        } as never,
      ),
      new AwsS3KnowledgeObjectStore(cloudConfig('aws-s3'), { send: copy } as never),
      new AwsS3KnowledgeObjectStore(cloudConfig('r2'), { send: copy } as never),
      new CosKnowledgeObjectStore(cloudConfig('cos'), { putObjectCopy: copy } as never),
      new OssKnowledgeObjectStore(cloudConfig('oss'), { copy } as never),
    ];
    for (const provider of providers) {
      for (const input of [
        {
          ...copyInput,
          sourceKey: 'ws/ws_other/space/space_contract/source/unbound/pending/blob/file.txt',
        },
        {
          ...copyInput,
          targetKey: 'ws/ws_contract/space/space_other/source/unbound/source/blob/file.txt',
        },
      ]) {
        const error = await provider
          .copyObjectImmutable(input, context)
          .catch((caught: unknown) => caught);
        expect(error).toMatchObject({
          problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
        });
      }
    }
    expect(copy).not.toHaveBeenCalled();
  });
});
