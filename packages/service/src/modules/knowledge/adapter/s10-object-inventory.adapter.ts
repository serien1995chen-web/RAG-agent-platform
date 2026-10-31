import { KnowledgeApiError } from '@kb/contracts';
import { Types, type Connection } from 'mongoose';
import type { Pool } from 'pg';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { requireWorkspaceId } from '../../../shared/persistence/knowledge/tenant';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type { KnowledgeObjectRefDoc } from '../../../shared/persistence/schemas/knowledge-operations.schemas';
import type { KnowledgeOutboxEventDoc } from '../../../shared/persistence/schemas/knowledge-job.schemas';
import { KNOWLEDGE_VECTOR_PROFILES } from '../../../shared/persistence/pgvector';

export interface S10InventoryObject {
  id: string;
  version: number;
  bucket: string;
  objectKey: string;
  sizeBytes: number;
  state: KnowledgeObjectRefDoc['state'];
}

export function isObjectHeadNotFound(error: unknown): boolean {
  return error instanceof KnowledgeApiError && error.problem.error.code === 'KNOWLEDGE_NOT_FOUND';
}

export class S10ObjectInventoryAdapter {
  private readonly objectRefs = registerKnowledgeModels;

  constructor(
    private readonly connection: Connection,
    private readonly pool: Pool,
  ) {}

  private models() {
    return this.objectRefs(this.connection);
  }

  async listObjects(context: TenantContext, limit = 500): Promise<S10InventoryObject[]> {
    const documents = await this.models()
      .KnowledgeObjectRef.find({
        workspaceId: requireWorkspaceId(context),
        deletedAt: null,
        state: { $in: ['pending', 'active', 'deleting'] },
      })
      .sort({ updatedAt: 1 })
      .limit(Math.max(1, Math.min(limit, 500)))
      .lean();
    return documents.map((document) => ({
      id: String(document._id),
      version: document.version,
      bucket: document.bucket,
      objectKey: document.objectKey,
      sizeBytes: document.sizeBytes,
      state: document.state,
    }));
  }

  async listActiveVectorIds(context: TenantContext): Promise<string[]> {
    const segments = await this.models()
      .KnowledgeSegment.find({
        workspaceId: requireWorkspaceId(context),
        deletedAt: null,
        indexStatus: 'indexed',
      })
      .select({ indexes: 1 })
      .lean();
    return [
      ...new Set(
        segments.flatMap((segment) =>
          (segment.indexes ?? [])
            .map((index) => index.vectorId)
            .filter((value): value is string => typeof value === 'string' && value.length > 0),
        ),
      ),
    ];
  }

  async listVectorIds(context: TenantContext): Promise<Array<{ table: string; id: string }>> {
    const rows: Array<{ table: string; id: string }> = [];
    for (const profile of KNOWLEDGE_VECTOR_PROFILES) {
      const result = await this.pool.query<{ id: string }>(
        `SELECT id::text AS id FROM ${profile.tableName} WHERE workspace_id = $1`,
        [requireWorkspaceId(context)],
      );
      rows.push(...result.rows.map((row) => ({ table: profile.tableName, id: row.id })));
    }
    return rows;
  }

  async fulltextDriftCount(context: TenantContext): Promise<number> {
    return this.models().KnowledgeSegment.countDocuments({
      workspaceId: requireWorkspaceId(context),
      deletedAt: null,
      searchEnabled: true,
      indexStatus: 'indexed',
      $or: [{ fullTextVersion: 0 }, { fullTextTokens: '' }],
    });
  }

  async outboxStatusCounts(
    context: TenantContext,
  ): Promise<Record<KnowledgeOutboxEventDoc['status'], number>> {
    const rows = await this.models().KnowledgeOutboxEvent.aggregate<{
      _id: KnowledgeOutboxEventDoc['status'];
      count: number;
    }>([
      { $match: { workspaceId: requireWorkspaceId(context), deletedAt: null } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    return Object.fromEntries(rows.map((row) => [row._id, row.count])) as Record<
      KnowledgeOutboxEventDoc['status'],
      number
    >;
  }

  async activeObjectReference(objectId: string, context: TenantContext): Promise<boolean> {
    const count = await this.models().KnowledgeSource.countDocuments({
      workspaceId: requireWorkspaceId(context),
      blobRefId: new Types.ObjectId(objectId),
      deletedAt: null,
      status: { $nin: ['deleted', 'archived'] },
    });
    return count > 0;
  }
}
