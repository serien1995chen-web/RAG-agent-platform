import { randomUUID } from 'node:crypto';
import { ApiErrorException, createApiError } from '@kb/contracts';
import type { ObjectStorePort, VectorController } from '../../../ports/capabilities';
import type { PortCallOptions, RequestContext } from '../../../ports/types';
import { classifyFailureError, isFailureExhausted } from '../domain/failure';

const MAX_ATTEMPTS = 10;
const DEFAULT_LEASE_MS = 300_000;
const DEFAULT_BATCH_LIMIT = 5000;
const DEFAULT_TIMEOUT_MS = 30_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 3_600_000;

export interface CompensationOperationView {
  operationId: string;
  teamId: string;
  operation: string;
  stage: string;
  attempt: number;
  resourceRef: { resourceType: string; resourceId: string; version: number };
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseExpireAt: Date | null;
}

export interface CompensationStore {
  claimExpiredLease(input: {
    now: Date;
    limit: number;
    leaseOwner?: string;
    leaseMs?: number;
  }): Promise<CompensationOperationView[]>;
  markStage(
    input: {
      operationId: string;
      stage: string;
      error?: Record<string, unknown> | null;
      attemptDelta?: number;
      nextAttemptAt?: Date;
      now?: Date;
    },
    context: RequestContext,
  ): Promise<boolean>;
  listByJob(
    input: { teamId: string; jobId: string },
    context: RequestContext,
  ): Promise<CompensationOperationView[]>;
  resetNextAttempt(
    input: { operationIds: string[]; now: Date },
    context: RequestContext,
  ): Promise<number>;
}

export interface CompensationServiceDeps {
  crossStore: CompensationStore;
  vectorController: VectorController;
  objectStore: ObjectStorePort;
  /** 正式引用核对（s3_ttl repository.hasFormalReference）。 */
  hasFormalReference?: (input: {
    teamId: string;
    objectKey: string;
    datasetId?: string;
  }) => Promise<boolean>;
  /** 资源存活复核（delete facts.hasLiveReference）。 */
  hasLiveReference?: (
    input: { objectKey?: string; dataId?: string; datasetId?: string },
    context: RequestContext,
  ) => Promise<boolean>;
  clock?: () => Date;
  batchLimit?: number;
  timeoutMs?: number;
  leaseOwner?: string;
  maxAttempts?: number;
}

export interface CompensationSweepStats {
  scanned: number;
  cleaned: number;
  failed: number;
  skipped: number;
}

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

function operationTeamId(operationId: string): string | null {
  const segments = operationId.split(':');
  const candidate = segments[1];
  if (candidate !== undefined && OBJECT_ID_PATTERN.test(candidate)) return candidate;
  return null;
}

/** jobId 冻结格式 teamId:datasetId[:scope...]:delete —— teamId 在首段。 */
function jobTeamId(jobId: string): string | null {
  const candidate = jobId.split(':')[0];
  if (candidate !== undefined && OBJECT_ID_PATTERN.test(candidate)) return candidate;
  return null;
}

function deriveContext(context: RequestContext, teamId: string): RequestContext {
  return { ...context, tenant: { ...context.tenant, teamId } };
}

/**
 * 跨存储补偿服务（设计 14.5 / 14.9 / AB §4.4）：
 * Sweeper 领取过期 lease，按 operation 重放（每步重校 teamId/引用）；≤10 次指数退避；
 * 跨租户/异常操作不领取；cleaned 终态不再改写；人工恢复只重排失败资源。
 */
export class CompensationApplicationService {
  constructor(private readonly deps: CompensationServiceDeps) {}

  async sweepOnce(context: RequestContext): Promise<CompensationSweepStats> {
    const now = this.now();
    const stats: CompensationSweepStats = { scanned: 0, cleaned: 0, failed: 0, skipped: 0 };
    const batch = await this.deps.crossStore.claimExpiredLease({
      now,
      limit: this.deps.batchLimit ?? DEFAULT_BATCH_LIMIT,
      leaseOwner: this.deps.leaseOwner ?? `compensation-${randomUUID()}`,
      leaseMs: DEFAULT_LEASE_MS,
    });
    for (const operation of batch) {
      stats.scanned += 1;
      const derived = deriveContext(context, operation.teamId);
      const options = this.optionsOf(context);
      try {
        const declaredTeamId = operationTeamId(operation.operationId);
        if (declaredTeamId === null || declaredTeamId !== operation.teamId) {
          // 跨租户/无法归属 op：拒绝重放，保留事实进入人工/对账路径。
          stats.skipped += 1;
          continue;
        }
        if (operation.stage === 'cleaned') {
          stats.skipped += 1;
          continue;
        }
        if (operation.operation === 'delete_vector') {
          if (this.deps.hasLiveReference) {
            const alive = await this.deps.hasLiveReference(
              { dataId: operation.resourceRef.resourceId },
              derived,
            );
            if (alive) {
              stats.skipped += 1;
              continue;
            }
          }
          const datasetId = datasetIdFromDeleteVectorOperationId(operation.operationId);
          if (datasetId === undefined) throw invalidOperation(operation.operationId, context);
          await this.deps.vectorController.delete(
            { datasetId, dataIds: [operation.resourceRef.resourceId], options },
            derived,
          );
          await this.deps.crossStore.markStage(
            { operationId: operation.operationId, stage: 'cleaned', now: this.now() },
            derived,
          );
          stats.cleaned += 1;
          continue;
        }
        if (operation.operation === 'delete_s3') {
          const objectKey = operation.resourceRef.resourceId;
          const referenced =
            this.deps.hasFormalReference !== undefined
              ? await this.deps.hasFormalReference({ teamId: operation.teamId, objectKey })
              : true;
          if (referenced) {
            // 已 promote/正式引用：只标记 cleaned，不删除对象。
            await this.deps.crossStore.markStage(
              { operationId: operation.operationId, stage: 'cleaned', now: this.now() },
              derived,
            );
            stats.cleaned += 1;
            continue;
          }
          const datasetId = datasetIdFromObjectKey(objectKey);
          await this.deps.objectStore.delete(
            {
              ref: { bucket: '', key: objectKey },
              options,
              ...(datasetId !== undefined ? { datasetId } : {}),
            },
            derived,
          );
          await this.deps.crossStore.markStage(
            { operationId: operation.operationId, stage: 'cleaned', now: this.now() },
            derived,
          );
          stats.cleaned += 1;
          continue;
        }
        if (operation.operation === 'switch_ref') {
          if (this.deps.hasLiveReference) {
            const alive = await this.deps.hasLiveReference(
              { datasetId: operation.resourceRef.resourceId },
              derived,
            );
            if (alive) {
              stats.skipped += 1;
              continue;
            }
          }
          await this.deps.crossStore.markStage(
            { operationId: operation.operationId, stage: 'cleaned', now: this.now() },
            derived,
          );
          stats.cleaned += 1;
          continue;
        }
        // write_vector 等非删除域 operation：不领取、不改写。
        stats.skipped += 1;
      } catch (error) {
        const classification = classifyFailureError(error);
        const nextAttempt = operation.attempt + 1;
        const exhausted =
          isFailureExhausted(nextAttempt) || nextAttempt >= (this.deps.maxAttempts ?? MAX_ATTEMPTS);
        if (exhausted) {
          await this.deps.crossStore.markStage(
            {
              operationId: operation.operationId,
              stage: 'failed',
              error: { errorClass: classification.errorClass, lastError: classification.lastError },
              attemptDelta: 1,
              now: this.now(),
            },
            derived,
          );
        } else {
          const backoffMs = Math.min(
            BACKOFF_BASE_MS * 2 ** Math.max(0, nextAttempt - 1),
            BACKOFF_CAP_MS,
          );
          await this.deps.crossStore.markStage(
            {
              operationId: operation.operationId,
              stage: operation.stage,
              error: { errorClass: classification.errorClass, lastError: classification.lastError },
              attemptDelta: 1,
              nextAttemptAt: new Date(now.getTime() + backoffMs),
              now: this.now(),
            },
            derived,
          );
        }
        stats.failed += 1;
      }
    }
    return stats;
  }

  /** 人工恢复：仅把该 job 关联的失败操作 nextAttemptAt=now；不覆盖已提交事实。 */
  async retryFailedResources(
    input: { jobId: string; teamId?: string },
    context: RequestContext,
  ): Promise<{ rescheduled: number }> {
    const teamId = input.teamId ?? jobTeamId(input.jobId) ?? context.tenant.teamId;
    const operations = await this.deps.crossStore.listByJob(
      { teamId, jobId: input.jobId },
      deriveContext(context, teamId),
    );
    const failedIds = operations
      .filter((operation) => operation.stage === 'failed' && operation.attempt < MAX_ATTEMPTS)
      .map((operation) => operation.operationId);
    const rescheduled = await this.deps.crossStore.resetNextAttempt(
      { operationIds: failedIds, now: this.now() },
      deriveContext(context, teamId),
    );
    return { rescheduled };
  }

  private optionsOf(context: RequestContext): PortCallOptions {
    return { timeoutMs: context.timeoutMs ?? this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS };
  }

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }
}

function datasetIdFromDeleteVectorOperationId(operationId: string): string | undefined {
  const segments = operationId.split(':');
  const candidate = segments[2];
  return candidate !== undefined && OBJECT_ID_PATTERN.test(candidate) ? candidate : undefined;
}

function datasetIdFromObjectKey(objectKey: string): string | undefined {
  const [prefix, datasetId] = objectKey.split('/');
  return prefix === 'dataset' && datasetId !== undefined && OBJECT_ID_PATTERN.test(datasetId)
    ? datasetId
    : undefined;
}

function invalidOperation(operationId: string, context: RequestContext): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501005,
      requestId: context.requestId,
      params: { taskId: operationId, from: 'operationId', to: 'invalid' },
    }),
  );
}
