import type { CollectionRepository } from '../../../ports/repositories';
import type { CollectionSnapshot, RequestContext } from '../../../ports/types';

export const MAX_COLLECTION_TAGS = 200;

export interface PathNode {
  id: string;
  name: string;
  parentId: string | null;
}

export interface CollectionTreeRepository extends CollectionRepository {
  get(
    input: { collectionId: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<CollectionSnapshot>;
  paths(
    input: { datasetId: string; sourceId: string; type: 'collection' },
    context: RequestContext,
  ): Promise<PathNode[]>;
  move(
    input: {
      collectionId: string;
      version: number;
      targetParentId: string | null;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ version: number }>;
  /**
   * 训练状态推进（parse/chunk 处理器使用）。
   * 只更新状态字段，不参与 version CAS（后台任务与前台编辑互不阻塞）。
   */
  markTrainingState(
    input: {
      collectionId: string;
      trainingState: 'running' | 'error' | 'ready';
      remainingTraining: number;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<void>;
}

export function isSameId(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return Boolean(left && right && String(left) === String(right));
}
