import type { RequestContext } from '../../../ports/types';

export const MAX_DATASET_TAGS = 200;

export interface TagSnapshot {
  tagId: string;
  teamId: string;
  datasetId: string;
  name: string;
  version: number;
  createTime: string;
  updateTime: string;
}

export interface CollectionTagRepository {
  list(
    input: { datasetId: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<TagSnapshot[]>;
  create(
    input: { datasetId: string; name: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<{ tagId: string }>;
  update(
    input: {
      datasetId: string;
      tagId: string;
      version: number;
      name: string;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ tagId: string; version: number }>;
  delete(
    input: { datasetId: string; tagId: string; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<{ affectedCollections: number }>;
  addToCollections(
    input: {
      datasetId: string;
      tagId: string;
      collectionIds: string[];
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ updated: string[]; skipped: string[] }>;
  removeFromCollections(
    input: {
      datasetId: string;
      tagId: string;
      collectionIds: string[];
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ updated: string[]; skipped: string[] }>;
}
