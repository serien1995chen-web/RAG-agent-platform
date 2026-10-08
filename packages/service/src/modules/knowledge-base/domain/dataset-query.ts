import type { ChunkPolicyValue } from '../../../shared/persistence/schemas';
import type { RequestContext } from '../../../ports/types';

/**
 * 派生只读查询契约（SKEL-ADR-008 proposed）。
 * 设计文档 7.6 的 PORT-DATA-001 只列 create/get/update/softDelete；
 * 12.9 的 API-DS-001/003 需要列表与子项计数，因此以独立查询 Port 补足，避免路由直接查库。
 */
export interface DatasetSummaryValue {
  datasetId: string;
  teamId: string;
  name: string;
  type: string;
  parentId: string | null;
  vectorModel: string;
  indexVersion: string;
  agentModel: string | null;
  vlmModel: string | null;
  chunkPolicy: ChunkPolicyValue;
  inheritPermission: boolean;
  autoSync: boolean;
  deleteTime: string | null;
  version: number;
  createTime: string;
  updateTime: string;
}

export interface DatasetListQueryInput {
  parentId: string | null;
  type: 'dataset' | 'folder' | null;
  page: number;
  limit: number;
}

export interface DatasetListResult {
  total: number;
  list: DatasetSummaryValue[];
}

export interface KnowledgeBaseQueryRepository {
  listByTeam(input: DatasetListQueryInput, context: RequestContext): Promise<DatasetListResult>;
  findByDatasetId(
    input: { datasetId: string },
    context: RequestContext,
  ): Promise<DatasetSummaryValue | null>;
  countChildren(datasetId: string, context: RequestContext): Promise<number>;
}

export interface DatasetUpdateInput {
  datasetId: string;
  version: number;
  patch: {
    parentId?: string | null;
    type?: string;
    name?: string;
    intro?: string;
    vectorModel?: string;
    agentModel?: string | null;
    vlmModel?: string | null;
    chunkPolicy?: ChunkPolicyValue;
    inheritPermission?: boolean;
    autoSync?: boolean;
  };
  options: { timeoutMs: number };
}
