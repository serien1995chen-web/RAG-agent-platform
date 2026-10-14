import { ApiErrorException, createApiError } from '@kb/contracts';
import { Types, type Connection, type Model } from 'mongoose';
import type { RequestContext } from '../../ports/types';
import {
  UsageItemSchema,
  UsageSchema,
  type UsageDoc,
  type UsageItemDoc,
} from '../persistence/schemas';

/**
 * 设计 10.15 / 15.4：Usage 适配器（usages 聚合 + usage_items 明细，TTL 360 天）。
 * 写入失败不阻塞主数据（degraded 返回）；读取支持 canonical 优先、legacy 回落与强制回滚开关。
 */
export interface UsageAdapterDeps {
  connection: Connection;
}

function notFound(requestId: string, resourceType: string, resourceId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({ code: 501070, requestId, params: { resourceType, resourceId } }),
  );
}

function readFailed(requestId: string, operation: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({ code: 501016, requestId, params: { store: 'mongo', operation } }),
  );
}

export class UsageAdapter {
  private readonly usages: Model<UsageDoc>;
  private readonly items: Model<UsageItemDoc>;

  constructor(connection: Connection) {
    this.usages =
      (connection.models.Usage as Model<UsageDoc> | undefined) ??
      connection.model<UsageDoc>('Usage', UsageSchema);
    this.items =
      (connection.models.UsageItem as Model<UsageItemDoc> | undefined) ??
      connection.model<UsageItemDoc>('UsageItem', UsageItemSchema);
  }

  async createUsage(
    input: {
      tmbId: string;
      source: string;
      appName: string;
      totalPoints: number;
      time?: Date;
      appId?: string | null;
      skillId?: string | null;
      datasetId?: string | null;
      list?: unknown[];
    },
    context: RequestContext,
  ): Promise<{ usageId: string | null; degraded: boolean }> {
    if (!Types.ObjectId.isValid(input.tmbId)) {
      throw notFound(context.requestId, 'tmb', input.tmbId);
    }
    const datasetId = input.datasetId;
    try {
      const doc = await this.usages.create({
        teamId: new Types.ObjectId(context.tenant.teamId),
        tmbId: new Types.ObjectId(input.tmbId),
        source: input.source,
        appName: input.appName,
        totalPoints: input.totalPoints,
        time: input.time ?? new Date(),
        appId: input.appId ?? null,
        skillId: input.skillId ?? null,
        datasetId:
          datasetId !== undefined && datasetId !== null && datasetId !== ''
            ? new Types.ObjectId(datasetId)
            : null,
        list: input.list ?? [],
      });
      return { usageId: String(doc._id), degraded: false };
    } catch {
      return { usageId: null, degraded: true };
    }
  }

  async pushUsageItems(
    input: {
      usageId: string;
      items: ReadonlyArray<{
        name: string;
        amount: number;
        itemType: string;
        time?: Date;
        inputTokens?: number | null;
        outputTokens?: number | null;
        charsLength?: number | null;
        duration?: number | null;
        pages?: number | null;
        count?: number | null;
        model?: string | null;
        dedupKey?: string | null;
      }>;
    },
    context: RequestContext,
  ): Promise<{ inserted: number; skipped: number; degraded: boolean }> {
    let inserted = 0;
    let skipped = 0;
    try {
      const teamId = new Types.ObjectId(context.tenant.teamId);
      for (const item of input.items) {
        const dedupKey = item.dedupKey ?? null;
        const doc = {
          teamId,
          usageId: input.usageId,
          name: item.name,
          amount: item.amount,
          itemType: item.itemType,
          time: item.time ?? new Date(),
          inputTokens: item.inputTokens ?? null,
          outputTokens: item.outputTokens ?? null,
          charsLength: item.charsLength ?? null,
          duration: item.duration ?? null,
          pages: item.pages ?? null,
          count: item.count ?? null,
          model: item.model ?? null,
          dedupKey,
        };
        if (dedupKey === null) {
          await this.items.insertOne(doc);
          inserted += 1;
          continue;
        }
        const result = await this.items.findOneAndUpdate(
          { teamId, dedupKey },
          { $setOnInsert: doc },
          { upsert: true, includeResultMetadata: true },
        );
        if (result.lastErrorObject?.upserted != null) {
          inserted += 1;
        } else {
          skipped += 1;
        }
      }
      return { inserted, skipped, degraded: false };
    } catch {
      return { inserted: 0, skipped: 0, degraded: true };
    }
  }

  async listUsageItems(
    input: { usageId: string; source?: 'canonical' | 'legacy' },
    context: RequestContext,
  ): Promise<{ items: unknown[]; source: 'canonical' | 'legacy' | 'empty' }> {
    try {
      const teamId = new Types.ObjectId(context.tenant.teamId);
      if (input.source !== 'legacy') {
        const items = await this.items.find({ teamId, usageId: input.usageId }).lean();
        if (items.length > 0) {
          return { items, source: 'canonical' };
        }
        if (input.source === 'canonical') {
          return { items: [], source: 'empty' };
        }
      }
      const legacy = await this.usages
        .findOne({ teamId, _id: new Types.ObjectId(input.usageId) }, { list: 1 })
        .lean();
      const list = legacy?.list ?? [];
      return list.length > 0 ? { items: list, source: 'legacy' } : { items: [], source: 'empty' };
    } catch {
      throw readFailed(context.requestId, 'listUsageItems');
    }
  }

  async compareUsageCounts(
    input: { usageId: string },
    context: RequestContext,
  ): Promise<{ canonical: number; legacy: number; equal: boolean }> {
    try {
      const teamId = new Types.ObjectId(context.tenant.teamId);
      const canonical = await this.items.countDocuments({ teamId, usageId: input.usageId });
      const legacyDoc = await this.usages
        .findOne({ teamId, _id: new Types.ObjectId(input.usageId) }, { list: 1 })
        .lean();
      const legacy = legacyDoc?.list?.length ?? 0;
      return { canonical, legacy, equal: canonical === legacy };
    } catch {
      throw readFailed(context.requestId, 'compareUsageCounts');
    }
  }
}

export function createUsageAdapter(deps: UsageAdapterDeps): UsageAdapter {
  return new UsageAdapter(deps.connection);
}
