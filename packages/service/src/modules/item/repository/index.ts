import { createUnimplementedPort } from '../../../ports/defaults';
import type { KnowledgeItemRepository } from '../../../ports/repositories';
import type { Connection } from 'mongoose';
import { MongoKnowledgeItemRepository } from './mongo-knowledge-item.repository';

export function createKnowledgeItemRepository(connection?: Connection): KnowledgeItemRepository {
  if (connection) return new MongoKnowledgeItemRepository(connection);
  return createUnimplementedPort<KnowledgeItemRepository>('KnowledgeItemRepository');
}

export { MongoImageAssetRepository, createImageAssetRepository, DEFAULT_IMAGE_TTL_MS } from "./mongo-image-asset.repository";
export type { ImageAssetRecord, ImageAssetState, CreateTemporaryInput } from "./mongo-image-asset.repository";
