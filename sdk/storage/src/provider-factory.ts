import {
  KNOWLEDGE_OBJECT_PROVIDERS,
  objectStoreError,
  type ObjectStoreConfig,
  type ObjectStorePort,
} from './object-store-contract';
import { AwsS3KnowledgeObjectStore } from './providers/aws-s3';
import { CosKnowledgeObjectStore } from './providers/cos';
import { MinioKnowledgeObjectStore } from './providers/minio';
import { OssKnowledgeObjectStore } from './providers/oss';

function missingFields(config: ObjectStoreConfig): string[] {
  if (config.provider === 'minio') {
    return [
      ...(config.endPoint.trim() ? [] : ['endpoint']),
      ...(config.region.trim() ? [] : ['region']),
      ...(config.bucket.trim() ? [] : ['bucket']),
      ...(config.accessKey.trim() ? [] : ['accessKey']),
      ...(config.secretKey.trim() ? [] : ['secretKey']),
      ...(config.credentialRefs && config.credentialRefs.length > 0 ? [] : ['credentialRefs']),
    ];
  }
  return [
    ...(config.endpoint.trim() ? [] : ['endpoint']),
    ...(config.region.trim() ? [] : ['region']),
    ...(config.bucket.trim() ? [] : ['bucket']),
    ...(config.credentials.accessKeyId.trim() ? [] : ['accessKeyId']),
    ...(config.credentials.secretAccessKey.trim() ? [] : ['secretAccessKey']),
    ...(config.credentialRefs.length > 0 ? [] : ['credentialRefs']),
  ];
}

export function validateObjectStoreConfig(config: ObjectStoreConfig): void {
  if (!KNOWLEDGE_OBJECT_PROVIDERS.includes(config.provider)) {
    throw objectStoreError(
      'KNOWLEDGE_VALIDATION_FAILED',
      { requestId: 'config', traceId: 'config' },
      { provider: String((config as { provider?: unknown }).provider) },
    );
  }
  const missing = missingFields(config);
  if (missing.length > 0) {
    throw objectStoreError(
      'KNOWLEDGE_VALIDATION_FAILED',
      { requestId: 'config', traceId: 'config' },
      { provider: config.provider, missingFields: missing },
    );
  }
}

export function createKnowledgeObjectStore(config: ObjectStoreConfig): ObjectStorePort {
  validateObjectStoreConfig(config);
  switch (config.provider) {
    case 'minio':
      return new MinioKnowledgeObjectStore(config);
    case 'aws-s3':
    case 'r2':
      return new AwsS3KnowledgeObjectStore(config);
    case 'cos':
      return new CosKnowledgeObjectStore(config);
    case 'oss':
      return new OssKnowledgeObjectStore(config);
  }
}
