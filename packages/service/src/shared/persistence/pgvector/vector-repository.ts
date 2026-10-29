import { createHash, randomUUID } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import type { Pool, PoolClient } from 'pg';
import type { TenantContext } from '../knowledge/tenant';
import { KNOWLEDGE_VECTOR_PROFILES, vectorProfileOfDimension, type VectorProfile } from './ddl';

export interface KnowledgeVectorRecordInput {
  workspaceId: string;
  knowledgeSpaceId: string;
  sourceId: string;
  segmentId: string;
  indexId: string;
  embeddingModelId: string;
  dimension: number;
  vector: readonly number[];
  searchEnabled: boolean;
  contentHash: string;
  version: number;
}

export interface KnowledgeVectorSearchInput {
  workspaceId: string;
  knowledgeSpaceId: string;
  sourceIds?: readonly string[];
  dimension: number;
  embeddingModelId: string;
  vector: readonly number[];
  limit: number;
  version?: number;
}

export interface KnowledgeVectorHit {
  vectorId: string;
  workspaceId: string;
  knowledgeSpaceId: string;
  sourceId: string;
  segmentId: string;
  indexId: string;
  version: number;
  score: number;
}

const UUID_NAMESPACE_URL = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');

function uuidV5(name: string): string {
  const digest = createHash('sha1').update(UUID_NAMESPACE_URL).update(name).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeVector(vector: readonly number[]): { vector: number[]; norm: number } {
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value)))
    return { vector: [], norm: 0 };
  const squares = vector.reduce((total, value) => total + value * value, 0);
  const norm = Math.sqrt(squares);
  if (norm === 0) return { vector: [], norm: 0 };
  return { vector: vector.map((value) => value / norm), norm };
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

export function stableKnowledgeVectorId(
  record: Pick<
    KnowledgeVectorRecordInput,
    | 'workspaceId'
    | 'knowledgeSpaceId'
    | 'sourceId'
    | 'segmentId'
    | 'indexId'
    | 'embeddingModelId'
    | 'version'
    | 'contentHash'
  >,
): string {
  return uuidV5(
    [
      'kb-vector:v1',
      record.workspaceId,
      record.knowledgeSpaceId,
      record.sourceId,
      record.segmentId,
      record.indexId,
      record.embeddingModelId,
      String(record.version),
      record.contentHash,
    ].join('|'),
  );
}

function vectorError(
  context: TenantContext,
  code:
    | 'KNOWLEDGE_VALIDATION_FAILED'
    | 'KNOWLEDGE_CONFLICT'
    | 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE'
    | 'KNOWLEDGE_DEPENDENCY_TIMEOUT',
  details: Record<string, unknown>,
) {
  return createKnowledgeError({
    code,
    requestId: context.requestId,
    traceId: context.traceId,
    details,
  });
}

export class KnowledgeVectorRepository {
  constructor(private readonly pool: Pool) {}

  async profile(dimension: number): Promise<VectorProfile | undefined> {
    return vectorProfileOfDimension(dimension);
  }

  async insert(
    records: readonly KnowledgeVectorRecordInput[],
    context: TenantContext,
  ): Promise<{ inserted: number; vectorIds: string[] }> {
    const vectorIds: string[] = [];
    for (const record of records) {
      if (record.workspaceId !== context.workspaceId) {
        throw vectorError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
          field: 'workspaceId',
          reason: 'tenant_mismatch',
        });
      }
      const profile = vectorProfileOfDimension(record.dimension);
      if (!profile || record.vector.length !== profile.dimension) {
        throw vectorError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
          field: 'dimension',
          expected: profile?.dimension ?? null,
          actual: record.vector.length,
        });
      }
      const normalized = normalizeVector(record.vector);
      if (normalized.vector.length === 0) {
        throw vectorError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
          field: 'vector',
          reason: 'zero_or_non_finite_norm',
        });
      }
      const vectorId = stableKnowledgeVectorId(record);
      try {
        const inserted = await this.pool.query(
          `INSERT INTO ${profile.tableName} (
            id, workspace_id, knowledge_space_id, source_id, segment_id, index_id,
            embedding_model_id, embedding, norm, search_enabled, content_hash, version
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8::${profile.storageType}, $9, $10, $11, $12
          )
          ON CONFLICT (id) DO UPDATE SET
            embedding = EXCLUDED.embedding,
            norm = EXCLUDED.norm,
            search_enabled = EXCLUDED.search_enabled,
            content_hash = EXCLUDED.content_hash,
            updated_at = now()
          WHERE ${profile.tableName}.content_hash = EXCLUDED.content_hash`,
          [
            vectorId,
            record.workspaceId,
            record.knowledgeSpaceId,
            record.sourceId,
            record.segmentId,
            record.indexId,
            record.embeddingModelId,
            vectorLiteral(normalized.vector),
            normalized.norm,
            record.searchEnabled,
            record.contentHash,
            record.version,
          ],
        );
        if (inserted.rowCount !== 1) {
          throw vectorError(context, 'KNOWLEDGE_CONFLICT', { vectorId });
        }
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'problem' in error) throw error;
        if ((error as { code?: string }).code === '23505') {
          throw vectorError(context, 'KNOWLEDGE_CONFLICT', { vectorId });
        }
        throw vectorError(context, 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE', {
          dependency: 'postgres',
          operation: 'vector_insert',
        });
      }
      vectorIds.push(vectorId);
    }
    return { inserted: records.length, vectorIds };
  }

  async recall(
    input: KnowledgeVectorSearchInput,
    context: TenantContext,
  ): Promise<KnowledgeVectorHit[]> {
    if (input.workspaceId !== context.workspaceId) {
      throw vectorError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'workspaceId',
        reason: 'tenant_mismatch',
      });
    }
    const profile = vectorProfileOfDimension(input.dimension);
    if (!profile || input.vector.length !== profile.dimension) {
      throw vectorError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'dimension',
        expected: profile?.dimension ?? null,
        actual: input.vector.length,
      });
    }
    const normalized = normalizeVector(input.vector);
    if (normalized.vector.length === 0) {
      throw vectorError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'vector',
        reason: 'zero_or_non_finite_norm',
      });
    }
    const values: unknown[] = [
      vectorLiteral(normalized.vector),
      input.workspaceId,
      input.knowledgeSpaceId,
      input.embeddingModelId,
    ];
    let sourcePredicate = '';
    if (input.sourceIds?.length) {
      values.push(input.sourceIds);
      sourcePredicate = ` AND source_id = ANY($${values.length}::text[])`;
    }
    let versionPredicate = '';
    if (input.version !== undefined) {
      values.push(input.version);
      versionPredicate = ` AND version = $${values.length}::bigint`;
    }
    values.push(Math.max(1, Math.min(input.limit, 200)));
    const limitParameter = values.length;
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      await client.query('SET LOCAL hnsw.ef_search = 100');
      const result = await client.query<{
        id: string;
        workspace_id: string;
        knowledge_space_id: string;
        source_id: string;
        segment_id: string;
        index_id: string;
        version: string;
        score: number;
      }>(
        `SELECT
          id, workspace_id, knowledge_space_id, source_id, segment_id, index_id,
          version, 1 - (embedding <=> $1::${profile.storageType}) AS score
        FROM ${profile.tableName}
        WHERE workspace_id = $2
          AND knowledge_space_id = $3
          AND embedding_model_id = $4
          AND search_enabled = true
          AND deleted_at IS NULL
          ${sourcePredicate}
          ${versionPredicate}
        ORDER BY embedding <=> $1::${profile.storageType}
        LIMIT $${limitParameter}`,
        values,
      );
      await client.query('COMMIT');
      return result.rows.map((row) => ({
        vectorId: row.id,
        workspaceId: row.workspace_id,
        knowledgeSpaceId: row.knowledge_space_id,
        sourceId: row.source_id,
        segmentId: row.segment_id,
        indexId: row.index_id,
        version: Number(row.version),
        score: Number(row.score),
      }));
    } catch (error) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // The original dependency error is the actionable failure.
        }
      }
      if ((error as { code?: string }).code === '57014') {
        throw vectorError(context, 'KNOWLEDGE_DEPENDENCY_TIMEOUT', {
          dependency: 'postgres',
          operation: 'vector_recall',
          reason: 'timeout',
        });
      }
      throw vectorError(context, 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE', {
        dependency: 'postgres',
        operation: 'vector_recall',
      });
    } finally {
      client?.release();
    }
  }

  async deleteBySegment(
    input: {
      workspaceId: string;
      knowledgeSpaceId: string;
      segmentId: string;
      dimension: number;
      embeddingModelId: string;
      indexId?: string;
    },
    context: TenantContext,
  ): Promise<{ deleted: number }> {
    if (input.workspaceId !== context.workspaceId) {
      throw vectorError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'workspaceId',
        reason: 'tenant_mismatch',
      });
    }
    const profile = vectorProfileOfDimension(input.dimension);
    if (!profile) {
      throw vectorError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'dimension',
        actual: input.dimension,
      });
    }
    const values: unknown[] = [
      input.workspaceId,
      input.knowledgeSpaceId,
      input.segmentId,
      input.embeddingModelId,
    ];
    let indexPredicate = '';
    if (input.indexId) {
      values.push(input.indexId);
      indexPredicate = ` AND index_id = $${values.length}`;
    }
    const result = await this.pool.query(
      `DELETE FROM ${profile.tableName}
       WHERE workspace_id = $1
         AND knowledge_space_id = $2
         AND segment_id = $3
         AND embedding_model_id = $4
         ${indexPredicate}`,
      values,
    );
    return { deleted: result.rowCount ?? 0 };
  }

  async deleteByIds(
    input: {
      workspaceId: string;
      dimension: 768 | 1024 | 1536 | 3072;
      vectorIds: readonly string[];
    },
    context: TenantContext,
  ): Promise<{ deleted: number }> {
    if (input.workspaceId !== context.workspaceId) {
      throw vectorError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'workspaceId',
        reason: 'tenant_mismatch',
      });
    }
    if (input.vectorIds.length === 0) return { deleted: 0 };
    const profile = vectorProfileOfDimension(input.dimension);
    if (!profile) {
      throw vectorError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'dimension',
        actual: input.dimension,
      });
    }
    try {
      const result = await this.pool.query(
        `DELETE FROM ${profile.tableName}
         WHERE workspace_id = $1
           AND id = ANY($2::uuid[])`,
        [input.workspaceId, [...input.vectorIds]],
      );
      return { deleted: result.rowCount ?? 0 };
    } catch {
      throw vectorError(context, 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE', {
        dependency: 'postgres',
        operation: 'vector_delete_by_ids',
        profile: profile.tableName,
      });
    }
  }

  async cleanupUnreferenced(
    input: {
      workspaceId: string;
      activeVectorIds: readonly string[];
      olderThan: Date;
      retentionCandidates?: ReadonlyArray<{
        vectorId: string;
        availableAt: Date;
      }>;
      now?: Date;
      batchSize?: number;
    },
    context: TenantContext,
  ): Promise<{ deleted: number; byProfile: Record<string, number> }> {
    if (input.workspaceId !== context.workspaceId) {
      throw vectorError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'workspaceId',
        reason: 'tenant_mismatch',
      });
    }
    const batchSize = Math.max(1, Math.min(input.batchSize ?? 500, 500));
    const now = input.now ?? new Date();
    const retentionPayload = (input.retentionCandidates ?? []).map((candidate) => ({
      vector_id: candidate.vectorId,
      available_at: candidate.availableAt.toISOString(),
    }));
    const byProfile: Record<string, number> = {};
    let deleted = 0;
    for (const profile of KNOWLEDGE_VECTOR_PROFILES) {
      try {
        const result = await this.pool.query(
          `WITH candidates AS (
             SELECT vector.id FROM ${profile.tableName} vector
             WHERE vector.workspace_id = $1
               AND vector.updated_at < $2
               AND NOT (vector.id = ANY($3::uuid[]))
               AND NOT EXISTS (
                 SELECT 1
                 FROM jsonb_to_recordset($5::jsonb)
                   AS retained(vector_id uuid, available_at timestamptz)
                 WHERE retained.vector_id = vector.id
                   AND retained.available_at > $6
               )
             ORDER BY vector.updated_at
             LIMIT $4
           )
           DELETE FROM ${profile.tableName} target
           USING candidates
           WHERE target.id = candidates.id`,
          [
            input.workspaceId,
            input.olderThan,
            [...input.activeVectorIds],
            batchSize,
            JSON.stringify(retentionPayload),
            now,
          ],
        );
        const count = result.rowCount ?? 0;
        byProfile[profile.tableName] = count;
        deleted += count;
      } catch {
        throw vectorError(context, 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE', {
          dependency: 'postgres',
          operation: 'vector_cleanup',
          profile: profile.tableName,
        });
      }
    }
    return { deleted, byProfile };
  }

  listProfiles(): readonly VectorProfile[] {
    return KNOWLEDGE_VECTOR_PROFILES;
  }

  stableVectorIdForTest(record: KnowledgeVectorRecordInput): string {
    const profile = vectorProfileOfDimension(record.dimension);
    if (!profile) return randomUUID();
    return stableKnowledgeVectorId(record);
  }
}
