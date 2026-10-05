import { createUnimplementedPort } from '../../../ports/defaults';
import type { VectorController } from '../../../ports/capabilities';

/** Repository 骨架：Phase 4 接入 Mongo/pgvector/全文实现，当前返回稳定未实现错误。 */
export function createKnowledgeItemIndexRepository(): VectorController {
  return createUnimplementedPort<VectorController>('VectorController');
}
