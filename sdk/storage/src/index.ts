export const PACKAGE_NAME = '@kb/storage' as const;

export {
  KNOWLEDGE_OBJECT_PROVIDERS,
  MinioKnowledgeObjectStore,
  assertKnowledgeObjectScope,
  createKnowledgeObjectStore,
  knowledgeObjectKey,
} from './knowledge-object-store';
export type {
  ExternalKnowledgeObjectStoreContract,
  KnowledgeObjectContext,
  KnowledgeObjectKeyInput,
  KnowledgeObjectProvider,
  KnowledgeObjectPurpose,
  KnowledgeObjectRef,
  KnowledgeObjectStoreConfig,
  MinioKnowledgeObjectStoreConfig,
} from './knowledge-object-store';
