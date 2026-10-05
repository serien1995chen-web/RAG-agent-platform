import { createUnimplementedPort } from '../../../ports/defaults';
import type { KnowledgeBaseRepository } from '../../../ports/repositories';

/** Adapter 骨架：只封装外部系统访问，不得改变业务状态。 */
export function createKnowledgeBaseAdapter(): KnowledgeBaseRepository {
  return createUnimplementedPort<KnowledgeBaseRepository>('KnowledgeBaseRepository-adapter');
}
