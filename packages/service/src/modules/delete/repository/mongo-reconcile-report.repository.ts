import { Types, type ClientSession, type Connection, type Model } from 'mongoose';
import {
  ReconcileReportSchema,
  type ReconcileReportDoc,
} from '../../../shared/persistence/schemas';

export interface ReconcileReportView {
  dedupKey: string;
  scope: Record<string, unknown>;
  teamId: string | null;
  state: string;
  counts: { scanned: number; success: number; failed: number; skipped: number };
  findings: Array<{ kind: string; sampleId: string; hash: string; action: string }>;
  sampleHash: string;
  windowStart: string;
  windowEnd: string;
  createTime: string;
}

export interface ReconcileReportListQuery {
  windowHours: number;
  scope: {
    teamIds?: string[];
    datasetIds?: string[];
    collectionIds?: string[];
  } | null;
  teamIds: string[] | null;
  state?: string;
  page: number;
  pageSize: number;
}

function toOid(value: string): Types.ObjectId | null {
  if (!Types.ObjectId.isValid(value)) return null;
  return new Types.ObjectId(value);
}

/**
 * 对账报告事实源（E2）：dedupKey 幂等 upsert；报告不保存全文。
 * start 仅建立 running 行，finish 覆写终态/计数/findings/sampleHash。
 */
export class MongoReconcileReportRepository {
  private readonly model: Model<ReconcileReportDoc>;

  constructor(connection: Connection) {
    this.model =
      (connection.models.ReconcileReport as Model<ReconcileReportDoc>) ??
      connection.model<ReconcileReportDoc>('ReconcileReport', ReconcileReportSchema);
  }

  /** running→completed/failed/pending_review 幂等 upsert（dedupKey 唯一）。 */
  async start(
    input: {
      dedupKey: string;
      scope: Record<string, unknown>;
      teamId: string | null;
      windowStart: Date;
      windowEnd: Date;
    },
    session?: ClientSession,
  ): Promise<void> {
    const teamId = input.teamId === null ? null : toOid(input.teamId);
    await this.model.updateOne(
      { dedupKey: input.dedupKey },
      {
        $setOnInsert: {
          scope: input.scope,
          teamId,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          state: 'running',
          counts: { scanned: 0, success: 0, failed: 0, skipped: 0 },
          findings: [],
          sampleHash: '',
          notificationId: null,
          dedupKey: input.dedupKey,
          reviewer: null,
          closedAt: null,
          evidenceExpireAt: null,
          createTime: new Date(),
        },
      },
      { upsert: true, ...(session !== undefined ? { session } : {}) },
    );
  }

  async finish(input: {
    dedupKey: string;
    state: 'running' | 'completed' | 'failed' | 'pending_review';
    counts: { scanned: number; success: number; failed: number; skipped: number };
    findings: Array<{ kind: string; sampleId: string; hash: string; action: string }>;
    sampleHash: string;
  }): Promise<boolean> {
    const result = await this.model.updateOne(
      { dedupKey: input.dedupKey },
      {
        $set: {
          state: input.state,
          counts: input.counts,
          findings: input.findings,
          sampleHash: input.sampleHash,
        },
      },
    );
    return (result.matchedCount ?? 0) > 0;
  }

  /** ROOT-004 分页查询：teamIds 为显式范围（null 表示 Root 显式全局）。 */
  async listReports(
    input: ReconcileReportListQuery,
  ): Promise<{ total: number; list: ReconcileReportView[] }> {
    const filter: Record<string, unknown> = {
      windowEnd: { $gte: new Date(Date.now() - input.windowHours * 3_600_000) },
    };
    if (input.teamIds !== null) {
      const ids = input.teamIds
        .map((id) => toOid(id))
        .filter((id): id is Types.ObjectId => id !== null);
      filter.teamId = { $in: ids };
    }
    if (input.state !== undefined && input.state !== '') {
      filter.state = input.state;
    }
    const datasetIds = input.scope?.datasetIds ?? [];
    const collectionIds = input.scope?.collectionIds ?? [];
    const scopeTeamIds = input.scope?.teamIds ?? [];
    if (input.teamIds === null && scopeTeamIds.length > 0) {
      const ids = scopeTeamIds
        .map((id) => toOid(id))
        .filter((id): id is Types.ObjectId => id !== null);
      filter.teamId = { $in: ids };
    }
    if (datasetIds.length > 0) {
      filter['scope.datasetId'] = { $in: datasetIds };
    }
    if (collectionIds.length > 0) {
      filter['scope.collectionId'] = { $in: collectionIds };
    }
    const [docs, total] = await Promise.all([
      this.model
        .find(filter)
        .sort({ createTime: -1, dedupKey: 1 })
        .skip((input.page - 1) * input.pageSize)
        .limit(input.pageSize)
        .lean(),
      this.model.countDocuments(filter),
    ]);
    return {
      total,
      list: (docs as unknown as Array<ReconcileReportDoc & { createTime: Date }>).map((doc) => ({
        dedupKey: doc.dedupKey,
        scope: doc.scope,
        teamId: doc.teamId === null ? null : String(doc.teamId),
        state: doc.state,
        counts: doc.counts,
        findings: doc.findings,
        sampleHash: doc.sampleHash,
        windowStart: doc.windowStart.toISOString(),
        windowEnd: doc.windowEnd.toISOString(),
        createTime: doc.createTime.toISOString(),
      })),
    };
  }
}
