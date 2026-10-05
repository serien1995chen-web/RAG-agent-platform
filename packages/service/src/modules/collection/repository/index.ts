import { createUnimplementedPort } from '../../../ports/defaults';
import type { CollectionRepository } from '../../../ports/repositories';

/** Repository 骨架：Phase 4 接入 Mongo/pgvector/全文实现，当前返回稳定未实现错误。 */
export function createSourceCollectionRepository(): CollectionRepository {
  return createUnimplementedPort<CollectionRepository>('CollectionRepository');
}
