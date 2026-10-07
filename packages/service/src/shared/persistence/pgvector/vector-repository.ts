import { ApiErrorException, createApiError } from '@kb/contracts';
import type { Pool } from 'pg';
import type { VectorController, VectorRecord, VectorSearchHit } from '../../../ports/capabilities';
import type { RequestContext } from '../../../ports/types';
import { validateTenantContext } from '../../../ports/types';
import { PGVECTOR_DIMENSION } from './ddl';

interface VectorRow {
  id: string;
  score?: number | string;
  team_id?: string;
  dataset_id?: string;
  collection_id?: string;
  index_version?: string;
  createtime?: Date;
  vector?: string;
}

/**
 * pgvector 适配仓储（设计文档 10.16 / 7.6）：
 * 所有 SQL 强制 team_id 谓词；pg id 使用 record.dataId；indexId 仅用于批内定位，不落库。
 */
export class PgVectorRepository implements VectorController {
  constructor(private readonly pool: Pool) {}

  private tenantError(context: RequestContext, missing: string[]): ApiErrorException {
    return new ApiErrorException(
      createApiError({
        code: 501012,
        requestId: context.requestId,
        params: { missing },
      }),
    );
  }

  private requireTeam(context: RequestContext): string {
    const result = validateTenantContext(context.tenant, context.requestId);
    if (!result.ok) throw new ApiErrorException(result.error);
    return context.tenant.teamId;
  }

  private assertScope(
    context: RequestContext,
    input: { teamId?: string; datasetId?: string; collectionId?: string },
    requireCollection: boolean,
  ): { teamId: string; datasetId: string } {
    const tenantTeam = this.requireTeam(context);
    const missing: string[] = [];
    if (!input.teamId || input.teamId !== tenantTeam) missing.push('teamId');
    if (!input.datasetId) missing.push('datasetId');
    if (requireCollection && !input.collectionId) missing.push('collectionId');
    if (missing.length > 0) throw this.tenantError(context, missing);
    return { teamId: input.teamId as string, datasetId: input.datasetId as string };
  }

  private async run<T>(
    operation: string,
    context: RequestContext,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ApiErrorException) throw error;
      throw new ApiErrorException(
        createApiError({
          code: 501014,
          requestId: context.requestId,
          params: { operation, store: 'pgvector' },
        }),
      );
    }
  }

  private toVectorLiteral(vector: readonly number[]): string {
    return `[${vector.join(',')}]`;
  }

  private parseVector(raw: string): number[] {
    return raw
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((item) => Number(item));
  }

  async insert(
    input: { records: VectorRecord[]; options: { timeoutMs: number } },
    context: RequestContext,
  ): Promise<{ inserted: number }> {
    return this.run('insert', context, async () => {
      for (const record of input.records) {
        this.assertScope(context, record, true);
        if (record.vector.length !== PGVECTOR_DIMENSION) {
          throw new ApiErrorException(
            createApiError({
              code: 501013,
              requestId: context.requestId,
              params: { expected: PGVECTOR_DIMENSION, actual: record.vector.length },
            }),
          );
        }
      }

      for (const record of input.records) {
        await this.pool.query(
          `INSERT INTO modeldata (id, vector, team_id, dataset_id, collection_id, index_version)
           VALUES ($1, $2::vector, $3, $4, $5, $6)
           ON CONFLICT (id) DO UPDATE SET
             vector = EXCLUDED.vector,
             team_id = EXCLUDED.team_id,
             dataset_id = EXCLUDED.dataset_id,
             collection_id = EXCLUDED.collection_id,
             index_version = EXCLUDED.index_version`,
          [
            record.dataId,
            this.toVectorLiteral(record.vector),
            record.teamId,
            record.datasetId,
            record.collectionId,
            record.indexVersion,
          ],
        );
      }

      return { inserted: input.records.length };
    });
  }

  async embRecall(
    input: {
      teamId: string;
      datasetId: string;
      collectionId?: string;
      vector: number[];
      limit: number;
      indexVersion?: string;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<VectorSearchHit[]> {
    return this.run('embRecall', context, async () => {
      this.assertScope(context, input, true);
      const values: unknown[] = [
        this.toVectorLiteral(input.vector),
        input.teamId,
        input.datasetId,
        input.collectionId,
      ];
      let sql = `SELECT id, 1 - (vector <=> $1::vector) AS score
        FROM modeldata
        WHERE team_id = $2 AND dataset_id = $3 AND collection_id = $4`;
      if (input.indexVersion !== undefined) {
        values.push(input.indexVersion);
        sql += ` AND index_version = $${values.length}`;
      }
      values.push(input.limit);
      sql += ` ORDER BY vector <=> $1::vector LIMIT $${values.length}`;

      const result = await this.pool.query<VectorRow>(sql, values);
      return result.rows.map((row) => ({
        dataId: String(row.id),
        indexId: String(row.id),
        score: Number(row.score),
      }));
    });
  }

  async delete(
    input: {
      dataIds?: string[];
      datasetId?: string;
      collectionId?: string;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<{ deleted: number }> {
    return this.run('delete', context, async () => {
      const teamId = this.requireTeam(context);
      const missing: string[] = [];
      if (!input.datasetId) missing.push('datasetId');
      if (missing.length > 0) throw this.tenantError(context, missing);

      const values: unknown[] = [teamId, input.datasetId];
      let sql = 'DELETE FROM modeldata WHERE team_id = $1 AND dataset_id = $2';
      if (input.collectionId !== undefined) {
        values.push(input.collectionId);
        sql += ` AND collection_id = $${values.length}`;
      }
      if (input.dataIds !== undefined && input.dataIds.length > 0) {
        values.push(input.dataIds);
        sql += ` AND id = ANY($${values.length})`;
      }

      const result = await this.pool.query(sql, values);
      return { deleted: result.rowCount ?? 0 };
    });
  }

  async getVectorDataByTime(
    input: {
      teamId: string;
      datasetId: string;
      from: string;
      to: string;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<VectorRecord[]> {
    return this.run('getVectorDataByTime', context, async () => {
      this.assertScope(context, input, false);
      const from = new Date(input.from);
      const to = new Date(input.to);
      if (
        Number.isNaN(from.getTime()) ||
        Number.isNaN(to.getTime()) ||
        from.getTime() > to.getTime()
      ) {
        throw new ApiErrorException(
          createApiError({
            code: 501050,
            requestId: context.requestId,
            params: { field: 'createtime', value: input.from, rangeOrVersion: input.to },
          }),
        );
      }

      const result = await this.pool.query<VectorRow>(
        `SELECT id, team_id, dataset_id, collection_id, index_version, createtime, vector::text AS vector
         FROM modeldata
         WHERE team_id = $1 AND dataset_id = $2 AND createtime >= $3 AND createtime <= $4
         ORDER BY createtime ASC`,
        [input.teamId, input.datasetId, from, to],
      );
      return result.rows.map((row) => ({
        teamId: String(row.team_id),
        datasetId: String(row.dataset_id),
        collectionId: String(row.collection_id),
        dataId: String(row.id),
        indexId: String(row.id),
        indexVersion: String(row.index_version),
        vector: this.parseVector(String(row.vector)),
      }));
    });
  }

  async getVectorCount(
    input: {
      teamId: string;
      datasetId: string;
      collectionId?: string;
      options: { timeoutMs: number };
    },
    context: RequestContext,
  ): Promise<number> {
    return this.run('getVectorCount', context, async () => {
      this.assertScope(context, input, false);
      const values: unknown[] = [input.teamId, input.datasetId];
      let sql =
        'SELECT COUNT(*)::int AS count FROM modeldata WHERE team_id = $1 AND dataset_id = $2';
      if (input.collectionId !== undefined) {
        values.push(input.collectionId);
        sql += ` AND collection_id = $${values.length}`;
      }
      const result = await this.pool.query<{ count: number }>(sql, values);
      return Number(result.rows[0]?.count ?? 0);
    });
  }
}
