import { ApiErrorException, createSkeletonError } from '@kb/contracts';
import type { RequestContext } from '../../../ports/types';
import type { CollectionRepository } from '../../../ports/repositories';
import type { PortCallOptions } from '../../../ports/types';
import type { CollectionSnapshot, PageResult } from '../../../ports/types';
import type { CollectionTreeRepository, PathNode } from '../domain/tree';

export interface SourceCollectionServiceDeps {
  repository: CollectionRepository & Partial<CollectionTreeRepository>;
}

/** SourceCollection 应用编排骨架：只依赖 Port，不直接拼装存储查询。 */
export class SourceCollectionApplicationService {
  constructor(private readonly deps: SourceCollectionServiceDeps) {}

  listCollections(
    input: {
      datasetId: string;
      parentId?: string | null;
      page: number;
      limit: number;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<PageResult<CollectionSnapshot>> {
    return this.deps.repository.list(input, context);
  }

  getCollection(
    input: { collectionId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<CollectionSnapshot> {
    if (!this.deps.repository.get) return Promise.reject(this.unsupported('getCollection'));
    return this.deps.repository.get(input, context);
  }

  listPaths(
    input: { datasetId: string; sourceId: string; type: 'collection'; options: PortCallOptions },
    context: RequestContext,
  ): Promise<PathNode[]> {
    if (!this.deps.repository.paths) return Promise.reject(this.unsupported('listPaths'));
    return this.deps.repository.paths(input, context);
  }

  moveCollection(
    input: {
      collectionId: string;
      version: number;
      targetParentId: string | null;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ version: number }> {
    if (!this.deps.repository.move) return Promise.reject(this.unsupported('moveCollection'));
    return this.deps.repository.move(input, context);
  }

  private unsupported(operation: string): ApiErrorException {
    return new ApiErrorException(
      createSkeletonError({ operation: `collection.${operation}` }, 'collection-application'),
    );
  }
}
