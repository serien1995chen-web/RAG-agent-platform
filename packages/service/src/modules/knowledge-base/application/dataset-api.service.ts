import { ApiErrorException, createApiError } from '@kb/contracts';
import type { KnowledgeBaseRepository } from '../../../ports/repositories';
import type { RequestContext } from '../../../ports/types';
import type {
  DatasetListResult,
  DatasetSummaryValue,
  KnowledgeBaseQueryRepository,
} from '../domain/dataset-query';

export interface DatasetApiServiceDeps {
  repository: KnowledgeBaseRepository & KnowledgeBaseQueryRepository;
}

export interface CreateDatasetInput {
  name: string;
  type: 'dataset' | 'folder';
  parentId?: string;
  vectorModel: string;
}

export interface ListDatasetsInput {
  parentId?: string;
  type?: 'dataset' | 'folder';
  page: number;
  limit: number;
}

export interface DatasetDetailResult {
  dataset: DatasetSummaryValue;
  stats: { collections: number; datas: number };
}

/** API-DS-001/002/003 的应用编排：路由只做校验与错误映射。 */
export class DatasetApiService {
  constructor(private readonly deps: DatasetApiServiceDeps) {}

  async createDataset(
    input: CreateDatasetInput,
    context: RequestContext,
  ): Promise<{ datasetId: string; state: 'ready' }> {
    const created = await this.deps.repository.create(
      {
        dataset: {
          teamId: context.tenant.teamId,
          parentId: input.parentId ?? null,
          type: input.type === 'folder' ? 'folder' : 'knowledge',
          name: input.name,
          intro: '',
          vectorModel: input.vectorModel,
          agentModel: null,
          vlmModel: null,
          inheritPermission: true,
          autoSync: false,
        },
        options: { timeoutMs: 10_000 },
      },
      context,
    );
    return { datasetId: created.datasetId, state: 'ready' };
  }

  async listDatasets(
    input: ListDatasetsInput,
    context: RequestContext,
  ): Promise<DatasetListResult> {
    return this.deps.repository.listByTeam(
      {
        parentId: input.parentId ?? null,
        type: input.type ?? null,
        page: input.page,
        limit: input.limit,
      },
      context,
    );
  }

  async getDatasetDetail(datasetId: string, context: RequestContext): Promise<DatasetDetailResult> {
    const dataset = await this.deps.repository.findByDatasetId({ datasetId }, context);
    if (!dataset) {
      throw new ApiErrorException(
        createApiError({
          code: 501070,
          requestId: context.requestId,
          params: { resourceType: 'dataset', resourceId: datasetId },
        }),
      );
    }
    const collections = await this.deps.repository.countChildren(datasetId, context);
    return { dataset, stats: { collections, datas: 0 } };
  }
}
