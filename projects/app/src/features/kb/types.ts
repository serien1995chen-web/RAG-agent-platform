export interface DatasetSummary {
  datasetId: string;
  teamId: string;
  parentId: string | null;
  type: string;
  name: string;
  intro?: string | null;
  avatar?: string | null;
  vectorModel?: string | null;
  indexVersion?: string | null;
  inheritPermission?: boolean;
  autoSync?: boolean;
  deleteTime?: string | null;
  version: number;
  createTime: string;
  updateTime: string;
}

export interface PermissionSnapshot {
  owner?: string;
  permissionMask?: number;
  inherited?: boolean;
  inheritEnabled?: boolean;
  version?: number;
  source?: string;
  collaboratorSummary?: Collaborator[];
}

export interface Collaborator {
  collaboratorType: string;
  collaboratorId: string;
  permissionMask: number;
}

export interface DatasetDetailData {
  dataset: DatasetSummary;
  permissionSnapshot: PermissionSnapshot;
  stats: { collections: number; datas: number };
}

export interface DatasetListData {
  total: number;
  list: DatasetSummary[];
}

export interface CollectionSummary {
  collectionId: string;
  teamId: string;
  datasetId: string;
  parentId: string | null;
  type: string;
  name: string;
  tagIds: string[];
  sourceRef?: string;
  trainingPolicy?: Record<string, unknown> | null;
  trainingState?: 'running' | 'error' | 'ready';
  remainingTraining?: number;
  trainingMode?: string;
  autoIndexes?: boolean;
  version: number;
  createTime: string;
  updateTime: string;
}

export interface CollectionListData {
  total: number;
  list: CollectionSummary[];
  cursor?: string | null;
}

export interface DataItem {
  dataId: string;
  teamId: string;
  datasetId: string;
  collectionId: string;
  q?: string | null;
  a?: string;
  chunkIndex?: number;
  indexes?: { indexId: string; type: string; dataId?: string | null; text: string }[];
  rebuilding?: boolean;
  version: number;
  createTime: string;
  updateTime: string;
}

export interface DataListData {
  total: number;
  list: DataItem[];
}

export interface DataDetailData {
  data: DataItem;
  indexes: DataItem['indexes'];
  metadata: Record<string, unknown>;
}

export interface Citation {
  dataId?: string;
  chunkIndex?: number;
  datasetId?: string;
  collectionId?: string;
  collectionName?: string;
  sourceName?: string;
  sourceType?: string;
  quoteText?: string;
  updateTime?: string;
  scores?: { type: string; value: number; index: number }[];
  imagePreviewUrls?: string[];
}

export interface SearchStats {
  searchMode?: string;
  usingReRank?: boolean;
  usingSimilarityFilter?: boolean;
  embeddingTokens?: number;
  rerankInputTokens?: number;
  degraded?: { stage: string; reason: string }[];
  durationMs?: number;
}

export interface SearchResultData {
  searchRes: { citations: Citation[]; stats: SearchStats };
  usingSimilarityFilter?: boolean;
}

export interface DeleteJobData {
  jobId?: string;
  state?: string;
  stage?: string;
  progress?: number;
  failureCount?: number;
  createTime?: string;
  updateTime?: string;
}

export interface DeleteFailureList {
  total: number;
  list: { resourceType?: string; resourceId?: string; reason?: string }[];
  cursor?: string | null;
}

export interface TrainingQueueMode {
  mode: string;
  depth: number;
  running: number;
}

export interface TrainingErrorItem {
  taskId?: string;
  jobId?: string;
  collectionId?: string;
  mode?: string;
  state?: string;
  errorMsg?: string;
  retryCount?: number;
  lockTime?: string | null;
}

export interface TrainingQueueData {
  modes: TrainingQueueMode[];
}

export interface TrainingErrorsData {
  total?: number;
  list?: TrainingErrorItem[];
  cursor?: string | null;
}

export interface TagItem {
  tagId: string;
  name: string;
  version?: number;
}

export interface TagListData {
  list: TagItem[];
}

export interface UploadedFileRef {
  fileId: string;
  fileRef: string;
}

export interface CreateCollectionResult {
  collectionId: string;
  insertLen?: number;
}

export type TabKey = 'docs' | 'data' | 'search' | 'training' | 'permission' | 'settings';
