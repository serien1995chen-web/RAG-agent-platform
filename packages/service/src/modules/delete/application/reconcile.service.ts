import { createHash } from 'node:crypto';
import type { FullTextStore, VectorController } from '../../../ports/capabilities';
import type { PortCallOptions, RequestContext } from '../../../ports/types';
import type {
  ReconcileFinding,
  ReconcileFindingKind,
  ReconcileMode,
  S3OrphanScanner,
  SchedulerReconcileSummary,
} from '../domain/findings';
import { RECONCILE_FINDING_KINDS } from '../domain/findings';
import type { DeleteScope } from './delete.service';

const SIX_HOURS_MS = 6 * 3_600_000;
const TWO_HOURS_MS = 2 * 3_600_000;
const TWENTY_FOUR_HOURS_MS = 24 * 3_600_000;
const SEVEN_DAYS_MS = 7 * 24 * 3_600_000;
const DEFAULT_BATCH_LIMIT = 5000;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ReconcileScope {
  kind: 'global' | 'team' | 'dataset' | 'collection';
  teamId?: string;
  datasetId?: string;
  collectionId?: string;
}

export interface ReconcileReportSummary {
  dedupKey: string;
  kind: ReconcileFindingKind;
  state: 'completed' | 'failed' | 'pending_review';
  counts: { scanned: number; success: number; failed: number; skipped: number };
  sampleHash: string;
  windowStart: string;
  windowEnd: string;
}

export interface ReconcileReportListResult {
  total: number;
  list: Array<{
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
  }>;
}

/** 对账事实源（E2 具体类以结构化类型满足）。 */
export interface ReconcileFactsStore {
  scanVectorCandidates(
    scope: DeleteScope,
    window: { start: Date; end: Date },
  ): Promise<{
    datasets: Array<{ datasetId: string; teamId: string }>;
    liveDataIds: string[];
    liveDatasetIds: string[];
    liveCollectionIds: string[];
  }>;
  scanFulltextCandidates(
    scope: DeleteScope,
    window: { start: Date; end: Date },
  ): Promise<Array<{ dataId: string; datasetId: string; collectionId: string }>>;
  scanAclOrphans(
    scope: DeleteScope,
  ): Promise<Array<{ id: string; teamId: string; resourceId: string }>>;
  scanTrainingOrphans(
    scope: DeleteScope,
  ): Promise<Array<{ id: string; teamId: string; datasetId: string; collectionId: string }>>;
  scanStuckDeleteJobs(
    now: Date,
    windowMs: number,
    teamId?: string,
  ): Promise<Array<{ jobId: string; teamId: string; attempt: number }>>;
  scanFailedCrossStoreOps(
    scope: DeleteScope,
  ): Promise<Array<{ operationId: string; operation: string; attempt: number }>>;
  hasTtlRecord(input: { teamId?: string; objectKey: string }): Promise<boolean>;
  deleteAclRows(ids: string[], teamId: string): Promise<number>;
  deleteTrainingRows(ids: string[], teamId: string): Promise<number>;
  requeueStuckJob(jobId: string, teamId: string): Promise<string>;
}

/** 对账报告事实源（E2）。 */
export interface ReconcileReportStore {
  start(input: {
    dedupKey: string;
    scope: Record<string, unknown>;
    teamId: string | null;
    windowStart: Date;
    windowEnd: Date;
  }): Promise<void>;
  finish(input: {
    dedupKey: string;
    state: 'running' | 'completed' | 'failed' | 'pending_review';
    counts: { scanned: number; success: number; failed: number; skipped: number };
    findings: Array<{ kind: string; sampleId: string; hash: string; action: string }>;
    sampleHash: string;
  }): Promise<boolean>;
  listReports(input: {
    windowHours: number;
    scope: { teamIds?: string[]; datasetIds?: string[]; collectionIds?: string[] } | null;
    teamIds: string[] | null;
    state?: string;
    page: number;
    pageSize: number;
  }): Promise<ReconcileReportListResult>;
}

/** TTL 补写能力（E2：mongo-s3-ttl repository 提供）。 */
export interface S3TtlBackfillStore {
  hasFormalReference(input: {
    teamId: string;
    objectKey: string;
    datasetId?: string;
  }): Promise<boolean>;
  backfill(input: {
    teamId: string;
    bucketName: string;
    objectKey: string;
    expireAt: Date;
    operationId: string;
    resourceRef: { resourceType: string; resourceId: string; version: number };
  }): Promise<void>;
}

export interface ReconcileServiceDeps {
  facts: ReconcileFactsStore;
  reports: ReconcileReportStore;
  vectorController: VectorController;
  fullTextStore?: FullTextStore;
  s3OrphanScanner?: S3OrphanScanner;
  s3TtlBackfill?: S3TtlBackfillStore;
  schedulerReconcileSummary?: () => Promise<SchedulerReconcileSummary>;
  clock?: () => Date;
  batchLimit?: number;
  pageSize?: number;
  timeoutMs?: number;
}

interface KindOutcome {
  kind: ReconcileFindingKind;
  findings: ReconcileFinding[];
  counts: { scanned: number; success: number; failed: number; skipped: number };
  pendingReview: boolean;
  dependencyFailed: boolean;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function objectKeyHash16(objectKey: string): string {
  return sha256(objectKey).slice(0, 16);
}

/**
 * 对账应用服务（设计 14.7 / 16.3 / AB §4.2）：
 * 小时级窗口 [now-6h, now-2h]；8 类 finding；单条失败继续、依赖失败整轮 failed；
 * dry-run 只报告，apply 仅按稳定幂等键清理可证明孤儿；报告 dedupKey 唯一且不含正文。
 */
export class ReconcileApplicationService {
  constructor(private readonly deps: ReconcileServiceDeps) {}

  async run(
    input: {
      windowStart?: Date;
      windowEnd?: Date;
      scope?: ReconcileScope;
      mode: ReconcileMode;
    },
    context: RequestContext,
  ): Promise<ReconcileReportSummary[]> {
    const now = this.now();
    const windowStart = input.windowStart ?? new Date(now.getTime() - SIX_HOURS_MS);
    const windowEnd = input.windowEnd ?? new Date(now.getTime() - TWO_HOURS_MS);
    const scope: ReconcileScope = input.scope ?? { kind: 'global' };
    const scopeKey = `${scope.kind}:${scope.teamId ?? ''}:${scope.datasetId ?? ''}:${scope.collectionId ?? ''}`;
    const window = { start: windowStart, end: windowEnd };

    const outcomes: KindOutcome[] = [];
    for (const kind of RECONCILE_FINDING_KINDS) {
      outcomes.push(await this.collectKind(kind, scope, window, input.mode, now, context));
    }
    const wholeRoundFailed = outcomes.some((outcome) => outcome.dependencyFailed);

    const summaries: ReconcileReportSummary[] = [];
    for (const outcome of outcomes) {
      const sampleIds = [...new Set(outcome.findings.map((finding) => finding.sampleId))].sort();
      const sampleHash = sha256(sampleIds.join('\n'));
      const dedupKey = sha256(
        `${windowStart.toISOString()}|${windowEnd.toISOString()}|${scopeKey}|${outcome.kind}|${sampleHash}`,
      );
      const state = wholeRoundFailed
        ? 'failed'
        : outcome.pendingReview
          ? 'pending_review'
          : 'completed';
      const storedScope: Record<string, unknown> = {
        kind: scope.kind,
        ...(scope.teamId !== undefined ? { teamId: scope.teamId } : {}),
        ...(scope.datasetId !== undefined ? { datasetId: scope.datasetId } : {}),
        ...(scope.collectionId !== undefined ? { collectionId: scope.collectionId } : {}),
      };
      await this.deps.reports.start({
        dedupKey,
        scope: storedScope,
        teamId: scope.teamId ?? null,
        windowStart,
        windowEnd,
      });
      await this.deps.reports.finish({
        dedupKey,
        state,
        counts: outcome.counts,
        findings: outcome.findings,
        sampleHash,
      });
      summaries.push({
        dedupKey,
        kind: outcome.kind,
        state,
        counts: outcome.counts,
        sampleHash,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
      });
    }
    return summaries;
  }

  /** ROOT-004：非 Root 强制当前 teamId；Root 以显式 scope 查询。 */
  async listReports(
    input: {
      windowHours: number;
      scope: { teamIds?: string[]; datasetIds?: string[]; collectionIds?: string[] } | null;
      state?: string;
      page: number;
      pageSize?: number;
    },
    context: RequestContext,
  ): Promise<ReconcileReportListResult> {
    const teamIds = context.tenant.isRoot ? null : [context.tenant.teamId];
    return this.deps.reports.listReports({
      windowHours: input.windowHours,
      scope: input.scope,
      teamIds,
      ...(input.state !== undefined ? { state: input.state } : {}),
      page: input.page,
      pageSize: input.pageSize ?? this.deps.pageSize ?? DEFAULT_PAGE_SIZE,
    });
  }

  private async collectKind(
    kind: ReconcileFindingKind,
    scope: ReconcileScope,
    window: { start: Date; end: Date },
    mode: ReconcileMode,
    now: Date,
    context: RequestContext,
  ): Promise<KindOutcome> {
    const outcome: KindOutcome = {
      kind,
      findings: [],
      counts: { scanned: 0, success: 0, failed: 0, skipped: 0 },
      pendingReview: false,
      dependencyFailed: false,
    };
    try {
      switch (kind) {
        case 'vector-orphan':
          await this.collectVectorOrphans(scope, window, mode, context, outcome);
          break;
        case 'fulltext-orphan':
          await this.collectFulltextOrphans(scope, window, mode, context, outcome);
          break;
        case 's3-orphan':
          await this.collectS3Orphans(scope, window, mode, now, outcome);
          break;
        case 'stuck-delete-job':
          await this.collectStuckDeleteJobs(scope, window, now, mode, outcome);
          break;
        case 'acl-orphan':
          await this.collectAclOrphans(scope, mode, outcome);
          break;
        case 'training-orphan':
          await this.collectTrainingOrphans(scope, mode, outcome);
          break;
        case 'scheduler-diff':
          await this.collectSchedulerDiff(outcome);
          break;
        case 'cross-store-failed':
          await this.collectCrossStoreFailures(scope, outcome);
          break;
      }
    } catch {
      outcome.dependencyFailed = true;
      outcome.counts.failed += 1;
    }
    return outcome;
  }

  private async collectVectorOrphans(
    scope: ReconcileScope,
    window: { start: Date; end: Date },
    mode: ReconcileMode,
    context: RequestContext,
    outcome: KindOutcome,
  ): Promise<void> {
    const candidates = await this.deps.facts.scanVectorCandidates(this.factsScope(scope), window);
    const liveDataIds = new Set(candidates.liveDataIds);
    const liveDatasetIds = new Set(candidates.liveDatasetIds);
    const liveCollectionIds = new Set(candidates.liveCollectionIds);
    const options = this.optionsOf(context);
    for (const dataset of candidates.datasets) {
      const rows = await this.deps.vectorController.getVectorDataByTime(
        {
          teamId: dataset.teamId,
          datasetId: dataset.datasetId,
          from: window.start.toISOString(),
          to: window.end.toISOString(),
          options,
        },
        context,
      );
      for (const row of rows) {
        outcome.counts.scanned += 1;
        try {
          const orphan =
            !liveDataIds.has(row.dataId) ||
            !liveDatasetIds.has(row.datasetId) ||
            (row.collectionId !== '' && !liveCollectionIds.has(row.collectionId));
          if (!orphan) {
            outcome.counts.skipped += 1;
            continue;
          }
          outcome.findings.push(
            this.finding('vector-orphan', row.dataId, mode === 'apply' ? 'cleanup' : 'report'),
          );
          if (mode === 'apply') {
            await this.deps.vectorController.delete({ dataIds: [row.dataId], options }, context);
          }
          outcome.counts.success += 1;
        } catch {
          outcome.counts.failed += 1;
        }
      }
    }
  }

  private async collectFulltextOrphans(
    scope: ReconcileScope,
    window: { start: Date; end: Date },
    mode: ReconcileMode,
    context: RequestContext,
    outcome: KindOutcome,
  ): Promise<void> {
    const candidates = await this.deps.facts.scanVectorCandidates(this.factsScope(scope), window);
    const liveDataIds = new Set(candidates.liveDataIds);
    const liveDatasetIds = new Set(candidates.liveDatasetIds);
    const liveCollectionIds = new Set(candidates.liveCollectionIds);
    const rows = await this.deps.facts.scanFulltextCandidates(this.factsScope(scope), window);
    const options = this.optionsOf(context);
    for (const row of rows) {
      outcome.counts.scanned += 1;
      try {
        const orphan =
          !liveDataIds.has(row.dataId) ||
          !liveDatasetIds.has(row.datasetId) ||
          !liveCollectionIds.has(row.collectionId);
        if (!orphan) {
          outcome.counts.skipped += 1;
          continue;
        }
        outcome.findings.push(
          this.finding('fulltext-orphan', row.dataId, mode === 'apply' ? 'cleanup' : 'report'),
        );
        if (mode === 'apply') {
          if (!this.deps.fullTextStore) {
            outcome.pendingReview = true;
            outcome.counts.skipped += 1;
            continue;
          }
          await this.deps.fullTextStore.deleteByDataId({ dataId: row.dataId, options }, context);
        }
        outcome.counts.success += 1;
      } catch {
        outcome.counts.failed += 1;
      }
    }
  }

  private async collectS3Orphans(
    scope: ReconcileScope,
    window: { start: Date; end: Date },
    mode: ReconcileMode,
    now: Date,
    outcome: KindOutcome,
  ): Promise<void> {
    if (!this.deps.s3OrphanScanner || !this.deps.s3TtlBackfill) {
      outcome.pendingReview = true;
      outcome.findings.push(
        this.finding('s3-orphan', sha256('s3-scanner-unavailable'), 'pending_review'),
      );
      outcome.counts.skipped += 1;
      return;
    }
    const candidates = await this.deps.facts.scanVectorCandidates(this.factsScope(scope), window);
    const datasetTeam = new Map(
      candidates.datasets.map((dataset) => [dataset.datasetId, dataset.teamId]),
    );
    const prefixes =
      scope.datasetId !== undefined
        ? [`dataset/${scope.datasetId}/`]
        : scope.teamId !== undefined
          ? [`temp/${scope.teamId}/`, `image/${scope.teamId}/`, 'dataset/']
          : ['temp/', 'image/', 'dataset/'];
    const limit = this.deps.batchLimit ?? DEFAULT_BATCH_LIMIT;
    for (const prefix of prefixes) {
      const objects = await this.deps.s3OrphanScanner.listByPrefix({ prefix, limit });
      for (const object of objects) {
        outcome.counts.scanned += 1;
        try {
          const resolvedTeamId = this.resolveTeamId(object.key, datasetTeam);
          if (resolvedTeamId === null) {
            outcome.pendingReview = true;
            outcome.findings.push(this.finding('s3-orphan', sha256(object.key), 'pending_review'));
            outcome.counts.skipped += 1;
            continue;
          }
          if (scope.teamId !== undefined && resolvedTeamId !== scope.teamId) {
            outcome.findings.push(this.finding('s3-orphan', sha256(object.key), 'audit'));
            outcome.counts.skipped += 1;
            continue;
          }
          if (
            await this.deps.facts.hasTtlRecord({ teamId: resolvedTeamId, objectKey: object.key })
          ) {
            outcome.counts.skipped += 1;
            continue;
          }
          if (
            await this.deps.s3TtlBackfill.hasFormalReference({
              teamId: resolvedTeamId,
              objectKey: object.key,
            })
          ) {
            outcome.counts.skipped += 1;
            continue;
          }
          if (!object.lastModified) {
            outcome.pendingReview = true;
            outcome.findings.push(this.finding('s3-orphan', sha256(object.key), 'pending_review'));
            outcome.counts.skipped += 1;
            continue;
          }
          if (now.getTime() - object.lastModified.getTime() < TWENTY_FOUR_HOURS_MS) {
            outcome.counts.skipped += 1;
            continue;
          }
          if (mode === 'dry-run') {
            outcome.findings.push(this.finding('s3-orphan', sha256(object.key), 'report'));
            outcome.counts.success += 1;
            continue;
          }
          await this.deps.s3TtlBackfill.backfill({
            teamId: resolvedTeamId,
            bucketName: '',
            objectKey: object.key,
            expireAt: new Date(now.getTime() + SEVEN_DAYS_MS),
            operationId: `s3ttl:${resolvedTeamId}:${objectKeyHash16(object.key)}:backfill`,
            resourceRef: { resourceType: 'object', resourceId: object.key, version: 0 },
          });
          outcome.findings.push(this.finding('s3-orphan', sha256(object.key), 'backfill'));
          outcome.counts.success += 1;
        } catch {
          outcome.pendingReview = true;
          outcome.counts.failed += 1;
          outcome.findings.push(this.finding('s3-orphan', sha256(object.key), 'pending_review'));
        }
      }
    }
  }

  private async collectStuckDeleteJobs(
    scope: ReconcileScope,
    window: { start: Date; end: Date },
    now: Date,
    mode: ReconcileMode,
    outcome: KindOutcome,
  ): Promise<void> {
    const windowMs = Math.max(1, window.end.getTime() - window.start.getTime());
    const rows = await this.deps.facts.scanStuckDeleteJobs(now, windowMs, scope.teamId);
    for (const row of rows) {
      outcome.counts.scanned += 1;
      try {
        if (mode === 'dry-run') {
          outcome.findings.push(this.finding('stuck-delete-job', row.jobId, 'report'));
          outcome.counts.success += 1;
          continue;
        }
        const result = await this.deps.facts.requeueStuckJob(row.jobId, row.teamId);
        if (result === 'manual_review') {
          outcome.pendingReview = true;
          outcome.findings.push(this.finding('stuck-delete-job', row.jobId, 'pending_review'));
          outcome.counts.skipped += 1;
          continue;
        }
        outcome.findings.push(this.finding('stuck-delete-job', row.jobId, 'requeue'));
        outcome.counts.success += 1;
      } catch {
        outcome.counts.failed += 1;
      }
    }
  }

  private async collectAclOrphans(
    scope: ReconcileScope,
    mode: ReconcileMode,
    outcome: KindOutcome,
  ): Promise<void> {
    const rows = await this.deps.facts.scanAclOrphans(this.factsScope(scope));
    for (const row of rows) {
      outcome.counts.scanned += 1;
      try {
        outcome.findings.push(
          this.finding('acl-orphan', row.resourceId, mode === 'apply' ? 'cleanup' : 'report'),
        );
        if (mode === 'apply') {
          await this.deps.facts.deleteAclRows([row.id], row.teamId);
        }
        outcome.counts.success += 1;
      } catch {
        outcome.counts.failed += 1;
      }
    }
  }

  private async collectTrainingOrphans(
    scope: ReconcileScope,
    mode: ReconcileMode,
    outcome: KindOutcome,
  ): Promise<void> {
    const rows = await this.deps.facts.scanTrainingOrphans(this.factsScope(scope));
    for (const row of rows) {
      outcome.counts.scanned += 1;
      try {
        outcome.findings.push(
          this.finding(
            'training-orphan',
            `${row.datasetId}:${row.collectionId}`,
            mode === 'apply' ? 'cleanup' : 'report',
          ),
        );
        if (mode === 'apply') {
          await this.deps.facts.deleteTrainingRows([row.id], row.teamId);
        }
        outcome.counts.success += 1;
      } catch {
        outcome.counts.failed += 1;
      }
    }
  }

  private async collectSchedulerDiff(outcome: KindOutcome): Promise<void> {
    if (!this.deps.schedulerReconcileSummary) {
      outcome.counts.skipped += 1;
      return;
    }
    const summary = await this.deps.schedulerReconcileSummary();
    outcome.counts.scanned += 1;
    const diff = summary.created + summary.dropped + summary.skipped_mismatch + summary.error;
    if (diff > 0) {
      outcome.findings.push(this.finding('scheduler-diff', sha256('scheduler'), 'report'));
      outcome.counts.success += 1;
      return;
    }
    outcome.counts.skipped += 1;
  }

  private async collectCrossStoreFailures(
    scope: ReconcileScope,
    outcome: KindOutcome,
  ): Promise<void> {
    const rows = await this.deps.facts.scanFailedCrossStoreOps(this.factsScope(scope));
    for (const row of rows) {
      outcome.counts.scanned += 1;
      outcome.findings.push(
        this.finding('cross-store-failed', row.operationId, 'pending_compensation'),
      );
      outcome.counts.success += 1;
    }
  }

  private factsScope(scope: ReconcileScope): DeleteScope {
    return {
      kind: scope.kind === 'collection' ? 'collection' : 'dataset',
      ...(scope.teamId !== undefined ? { teamId: scope.teamId } : {}),
      ...(scope.datasetId !== undefined ? { datasetId: scope.datasetId } : {}),
      ...(scope.collectionId !== undefined ? { collectionId: scope.collectionId } : {}),
    };
  }

  private resolveTeamId(objectKey: string, datasetTeam: Map<string, string>): string | null {
    const [prefix, scopeId] = objectKey.split('/');
    if ((prefix === 'temp' || prefix === 'image') && scopeId !== undefined && scopeId !== '') {
      return scopeId;
    }
    if (prefix === 'dataset' && scopeId !== undefined && scopeId !== '') {
      return datasetTeam.get(scopeId) ?? null;
    }
    return null;
  }

  private finding(kind: ReconcileFindingKind, sampleId: string, action: string): ReconcileFinding {
    return { kind, sampleId, hash: sha256(sampleId), action };
  }

  private optionsOf(context: RequestContext): PortCallOptions {
    return { timeoutMs: context.timeoutMs ?? this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS };
  }

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }
}
