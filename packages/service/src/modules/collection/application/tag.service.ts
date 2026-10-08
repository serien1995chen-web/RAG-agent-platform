import type { RequestContext } from '../../../ports/types';
import type { PortCallOptions } from '../../../ports/types';
import type { CollectionTagRepository, TagSnapshot } from '../domain/tag';

export interface TagServiceDeps {
  repository: CollectionTagRepository;
}

export class TagService {
  constructor(private readonly deps: TagServiceDeps) {}

  listTags(
    input: { datasetId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<TagSnapshot[]> {
    return this.deps.repository.list(input, context);
  }

  createTag(
    input: { datasetId: string; name: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ tagId: string }> {
    return this.deps.repository.create(input, context);
  }

  updateTag(
    input: {
      datasetId: string;
      tagId: string;
      version: number;
      name: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ tagId: string; version: number }> {
    return this.deps.repository.update(input, context);
  }

  deleteTag(
    input: { datasetId: string; tagId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ affectedCollections: number }> {
    return this.deps.repository.delete(input, context);
  }

  addToCollections(
    input: {
      datasetId: string;
      tagId: string;
      collectionIds: string[];
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ updated: string[]; skipped: string[] }> {
    return this.deps.repository.addToCollections(input, context);
  }

  removeFromCollections(
    input: {
      datasetId: string;
      tagId: string;
      collectionIds: string[];
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ updated: string[]; skipped: string[] }> {
    return this.deps.repository.removeFromCollections(input, context);
  }
}
