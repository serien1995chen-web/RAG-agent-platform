export const PACKAGE_NAME = '@kb/storage' as const;

export {
  KNOWLEDGE_OBJECT_PROVIDERS,
  MinioKnowledgeObjectStore,
  assertKnowledgeObjectKey,
  assertKnowledgeObjectScope,
  createKnowledgeObjectStore,
  knowledgeObjectKey,
  safeKeySegment,
  validateObjectStoreConfig,
} from './knowledge-object-store';
export type {
  CloudKnowledgeObjectStoreConfig,
  KnowledgeObjectContext,
  KnowledgeObjectKeyInput,
  KnowledgeObjectProvider,
  KnowledgeObjectPurpose,
  KnowledgeObjectRef,
  KnowledgeObjectStoreConfig,
  MinioKnowledgeObjectStoreConfig,
  ObjectStoreConfig,
} from './knowledge-object-store';
export type {
  MultipartCompleteResult,
  MultipartPart,
  ObjectCopyInput,
  ObjectCopyResult,
  ObjectHeadResult,
  ObjectPutInput,
  ObjectStoreCredentials,
  ObjectStorePort,
  ObjectStreamResult,
  PresignedGetResult,
  PresignedUploadResult,
  ProviderVerificationStatus,
} from './object-store-contract';
export { AwsS3KnowledgeObjectStore } from './providers/aws-s3';
export { CosKnowledgeObjectStore } from './providers/cos';
export { OssKnowledgeObjectStore } from './providers/oss';
export { FileTicketService } from './file-ticket';
export type { FileTicketClaims, FileTicketDisposition, FileTicketResult } from './file-ticket';
