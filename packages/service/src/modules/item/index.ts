export {
  KNOWLEDGE_ITEM_INVARIANTS,
  buildQaDedupKey,
  normalizeQaText,
  validateKnowledgeItem,
} from './domain';
export type { KnowledgeItem, KnowledgeItemQueryRepository } from './domain';
export { KnowledgeItemApplicationService } from './application';
export type { KnowledgeItemServiceDeps } from './application';
export { createKnowledgeItemRepository } from './repository';
export { createKnowledgeItemAdapter } from './adapter';
export { KNOWLEDGE_ITEM_JOB_DEFINITIONS, createKnowledgeItemJobHandler } from './jobs';
export type { KnowledgeItemJobHandler } from './jobs';
export { InsertDataService } from './application/insert-data.service';
export type { InsertDataServiceDeps } from './application/insert-data.service';
export { MongoKnowledgeItemRepository } from './repository/mongo-knowledge-item.repository';
