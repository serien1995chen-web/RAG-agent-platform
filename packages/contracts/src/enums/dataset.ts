import { z } from 'zod';

/**
 * 设计文档 2.8：所有创建入口必须拒绝网站知识库类型。
 * 该常量是 websiteDataset 字面量在业务代码中的唯一允许落点。
 */
export const WEBSITE_DATASET_TYPE = 'websiteDataset' as const;

export const ACCEPTED_DATASET_TYPES = [
  'dataset',
  'folder',
  'knowledge',
  'external',
  'api',
  'feishu',
  'yuque',
  'dingtalk',
] as const;

export const REJECTED_DATASET_TYPES = [WEBSITE_DATASET_TYPE, 'unknown'] as const;

export const DatasetTypeSchema = z.enum(ACCEPTED_DATASET_TYPES);
export type DatasetType = z.infer<typeof DatasetTypeSchema>;

export const TRAINING_MODES = ['parse', 'chunk', 'qa', 'image', 'imageParse', 'auto'] as const;
export const TrainingModeSchema = z.enum(TRAINING_MODES);
export type TrainingMode = z.infer<typeof TrainingModeSchema>;

export const SEARCH_MODES = ['embedding', 'fullTextRecall', 'mixedRecall'] as const;
export const SearchModeSchema = z.enum(SEARCH_MODES);
export type SearchMode = z.infer<typeof SearchModeSchema>;

export const INDEX_TYPES = [
  'default',
  'imageEmbedding',
  'summary',
  'question',
  'image',
  'custom',
] as const;
export const IndexTypeSchema = z.enum(INDEX_TYPES);
export type IndexType = z.infer<typeof IndexTypeSchema>;

export const TRAINING_TASK_STATES = [
  'active',
  'running',
  'failed',
  'final_error',
  'blocked',
] as const;
export const COLLECTION_TRAINING_STATES = ['running', 'error', 'ready'] as const;
export const DELETE_JOB_STATES = ['marked', 'queued', 'deleting', 'completed', 'failed'] as const;

export function isDatasetTypeAccepted(type: string): boolean {
  return (ACCEPTED_DATASET_TYPES as readonly string[]).includes(type);
}

export function datasetTypeRejection(type: string): {
  code: number;
  messageKey: string;
  params: { type: string };
} | null {
  if (isDatasetTypeAccepted(type)) return null;
  return { code: 501001, messageKey: 'dataset.unsupported_type', params: { type } };
}
