import type { Pool } from 'pg';
import type { VectorController, VectorRecord, VectorSearchHit } from '../../../ports/capabilities';
import type { PortCallOptions, RequestContext } from '../../../ports/types';
import { PgVectorRepository } from '../../../shared/persistence/pgvector';

/**
 * VectorController Adapter（P2-04）：薄委托到 PgVectorRepository，只封装外部 pgvector 访问。
 * 装配入口（modules/index/adapter/index.ts）由 P2-17 负责，本文件不修改 barrel。
 */
export class VectorControllerAdapter implements VectorController {
  constructor(private readonly repository: PgVectorRepository) {}

  insert(
    input: { records: VectorRecord[]; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ inserted: number }> {
    return this.repository.insert(input, context);
  }

  delete(
    input: {
      dataIds?: string[];
      datasetId?: string;
      collectionId?: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<{ deleted: number }> {
    return this.repository.delete(input, context);
  }

  embRecall(
    input: {
      teamId: string;
      datasetId: string;
      collectionId?: string;
      vector: number[];
      limit: number;
      indexVersion?: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<VectorSearchHit[]> {
    return this.repository.embRecall(input, context);
  }

  getVectorDataByTime(
    input: {
      teamId: string;
      datasetId: string;
      from: string;
      to: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<VectorRecord[]> {
    return this.repository.getVectorDataByTime(input, context);
  }

  getVectorCount(
    input: { teamId: string; datasetId: string; collectionId?: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<number> {
    return this.repository.getVectorCount(input, context);
  }
}

export function createVectorControllerAdapter(pool: Pool): VectorController {
  return new VectorControllerAdapter(new PgVectorRepository(pool));
}
