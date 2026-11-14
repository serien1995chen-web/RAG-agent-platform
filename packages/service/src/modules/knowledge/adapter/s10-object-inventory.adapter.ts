import { KnowledgeApiError, createKnowledgeError } from '@kb/contracts';
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
  knowledgeSpaceId: string;
  objectKey: string;
  objectKeys: string[];
  sizeBytes: number;
  state: KnowledgeObjectRefDoc['state'];
}

export interface S10BucketObject {
  bucket: string;
  knowledgeSpaceId: string;
  objectKey: string;
  sizeBytes: number;
  lastModified: string;
}

interface S10ObjectListStore {
  readonly bucket: string;
  listObjects(input: {
    prefix: string;
    cursor: string | null;
    limit: number;
    context: {
      workspaceId: string;
      knowledgeSpaceId: string;
      requestId: string;
      traceId: string;
    };
  }): Promise<{
    items: Array<{ key: string; sizeBytes: number; lastModified: string }>;
    nextCursor: string | null;
  }>;
}

type S10ObjectRefRecord = KnowledgeObjectRefDoc & { _id: Types.ObjectId };

function knowledgeWorkspacePrefix(workspaceId: string): string {
  const safe = workspaceId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180) || 'object';
  return `ws/${safe}/`;
}

export function isObjectHeadNotFound(error: unknown): boolean {
  if (!(error instanceof KnowledgeApiError) || error.problem.error.code !== 'KNOWLEDGE_NOT_FOUND') {
    return false;
  }
  const details = error.problem.error.details;
  return (
    details?.operation === 'headObject' ||
    (typeof details?.provider === 'string' && details.status === 404)
  );
}

export class S10ObjectInventoryAdapter {
  private readonly objectRefs = registerKnowledgeModels;

  constructor(
    private readonly connection: Connection,
    private readonly pool: Pool,
    private readonly objectStore?: S10ObjectListStore,
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
      knowledgeSpaceId: String(document.knowledgeSpaceId),
      objectKey: document.objectKey,
      objectKeys: [
        ...new Set(
          [
            document.objectKey,
            document.upload?.finalObjectKey,
            document.upload?.pendingObjectKey,
          ].filter((key): key is string => typeof key === 'string' && key.length > 0),
        ),
      ],
      sizeBytes: document.sizeBytes,
      state: document.state,
    }));
  }

  async listAllObjects(context: TenantContext, batchSize = 500): Promise<S10InventoryObject[]> {
    const items: S10InventoryObject[] = [];
    let lastId: Types.ObjectId | null = null;
    const limit = Math.max(1, Math.min(batchSize, 500));
    while (true) {
      const documents: S10ObjectRefRecord[] = await this.models()
        .KnowledgeObjectRef.find({
          workspaceId: requireWorkspaceId(context),
          deletedAt: null,
          state: { $in: ['pending', 'active', 'deleting'] },
          ...(lastId === null ? {} : { _id: { $gt: lastId } }),
        })
        .sort({ _id: 1 })
        .limit(limit)
        .lean<S10ObjectRefRecord[]>();
      items.push(
        ...documents.map((document) => ({
          id: String(document._id),
          version: document.version,
          bucket: document.bucket,
          knowledgeSpaceId: String(document.knowledgeSpaceId),
          objectKey: document.objectKey,
          objectKeys: [
            ...new Set(
              [
                document.objectKey,
                document.upload?.finalObjectKey,
                document.upload?.pendingObjectKey,
              ].filter((key): key is string => typeof key === 'string' && key.length > 0),
            ),
          ],
          sizeBytes: document.sizeBytes,
          state: document.state,
        })),
      );
      if (documents.length < limit) return items;
      lastId = documents[documents.length - 1]!._id;
    }
  }

  async listBucketObjects(context: TenantContext): Promise<S10BucketObject[]> {
    if (!this.objectStore) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
        requestId: context.requestId,
        traceId: context.traceId,
        retryable: true,
        details: {
          dependency: 'object_store',
          operation: 'listObjects',
          reason: 'inventory_not_configured',
        },
      });
    }
    const prefix = knowledgeWorkspacePrefix(requireWorkspaceId(context));
    const items: S10BucketObject[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await this.objectStore.listObjects({
        prefix,
        cursor,
        limit: 500,
        context: {
          workspaceId: context.workspaceId,
          knowledgeSpaceId: 'system',
          requestId: context.requestId,
          traceId: context.traceId,
        },
      });
      for (const item of page.items) {
        const parts = item.key.split('/');
        if (
          parts.length < 6 ||
          parts[0] !== 'ws' ||
          `ws/${parts[1]}/` !== prefix ||
          parts[2] !== 'space' ||
          !parts[3]
        ) {
          throw createKnowledgeError({
            code: 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID',
            requestId: context.requestId,
            traceId: context.traceId,
            details: { operation: 'listObjects', reason: 'object_key_scope_invalid' },
          });
        }
        items.push({
          bucket: this.objectStore.bucket,
          knowledgeSpaceId: parts[3],
          objectKey: item.key,
          sizeBytes: item.sizeBytes,
          lastModified: item.lastModified,
        });
      }
      cursor = page.nextCursor;
      if (cursor !== null && seenCursors.has(cursor)) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { operation: 'listObjects', reason: 'cursor_repeated' },
        });
      }
      if (cursor !== null) seenCursors.add(cursor);
    } while (cursor !== null);
    return items;
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
