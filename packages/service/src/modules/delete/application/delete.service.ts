import { randomUUID } from 'node:crypto';
import {
  ApiErrorException,
  classifyRetryableError,
  createApiError,
  createInternalError,
} from '@kb/contracts';
import { QUEUE_NAMES, buildDeleteJobId, type QueuePort } from '@kb/dal';
import type { ObjectStorePort, VectorController } from '../../../ports/capabilities';
import type {
  DeleteJobSnapshot,
  DeleteJobState,
  ObjectRef,
  PageResult,
  PortCallOptions,
  RequestContext,
} from '../../../ports/types';
import { DELETE_STAGES, assertStageOrder, canRetryDeleteJob } from '../domain/state-machine';

const MAX_DELETE_ATTEMPTS = 10;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/** 删除范围（三类入口共用；jobId 冻结格式内嵌 datasetId 等段）。 */
export type DeleteScopeKind = 'dataset' | 'collection' | 'data';

export interface DeleteScope {
  kind: DeleteScopeKind;
  /** 对账/扫描的显式租户范围；删除入口忽略该字段（teamId 只来自认证上下文）。 */
  teamId?: string;
  datasetId?: string;
  collectionId?: string;
  dataId?: string;
}

export interface DeleteRequestResult {
  jobId: string;
  state: DeleteJobState;
}

export interface DeleteJobScopeView {
  jobId: string;
  state: DeleteJobState;
  datasetId: string;
  actorTmbId: string | null;
  ownerTmbId: string | null;
}

export interface DeleteCleanupStats {
  scanned: number;
  deleted: number;
  failed: number;
  skipped: number;
  errorMsg?: string;
}

export interface DeleteLeaseClaim {
  jobId: string;
  datasetId: string;
  state: DeleteJobState;
  stage: string;
  attempt: number;
  leaseOwner: string;
}

export interface DeleteFailureWrite {
  jobId: string;
  resourceType: string;
  resourceId: string;
  stage: string;
  attempt: number;
  errorClass: string;
  retryable: boolean;
  lastError: string;
}

export interface DeleteTransactionOutcome {
  deleteJobId: string;
  datasetId: string;
  state: 'marked' | 'completed' | 'failed';
  existing: boolean;
  objectRefs: ObjectRef[];
  vectorDataIds: string[];
}

/** 删除任务事实源（E1 具体类以结构化类型满足；application 不导入 repository 实现）。 */
export interface DeleteJobStore {
  get(
    input: { jobId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<DeleteJobSnapshot>;
  findByScope(
    input: {
      datasetId?: string;
      collectionId?: string;
      dataId?: string;
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<DeleteJobScopeView | null>;
  listFailures(
    input: { jobId: string; cursor?: string; limit: number; options: PortCallOptions },
    context: RequestContext,
  ): Promise<PageResult<{ resourceType: string; resourceId: string; reason: string }>>;
  retry(
    input: { jobId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ accepted: boolean }>;
  transition(
    input: {
      jobId: string;
      expectedState: DeleteJobState;
      nextState: DeleteJobState;
      stage?: string;
      progress?: { total: number; done: number; failed: number; skipped: number };
      options: PortCallOptions;
    },
    context: RequestContext,
  ): Promise<DeleteJobSnapshot>;
  claimWithLease(
    input: { jobId: string; leaseOwner: string; leaseMs: number; now: Date },
    context: RequestContext,
  ): Promise<DeleteLeaseClaim | null>;
  renewLease(
    input: { jobId: string; leaseOwner: string; leaseMs: number; now: Date },
    context: RequestContext,
  ): Promise<boolean>;
  releaseLease(
    input: { jobId: string; leaseOwner: string; now: Date },
    context: RequestContext,
  ): Promise<void>;
  updateProgressGuarded(
    input: {
      jobId: string;
      leaseOwner: string;
      stage?: string;
      progress?: { total: number; done: number; failed: number; skipped: number };
      now?: Date;
    },
    context: RequestContext,
  ): Promise<boolean>;
  recordFailure(input: DeleteFailureWrite, context: RequestContext): Promise<void>;
  resetRetry(input: { jobId: string }, context: RequestContext): Promise<boolean>;
}

/** 跨存储操作事实源（E1）。 */
export interface CrossStoreStore {
  markStage(
    input: {
      operationId: string;
      stage: string;
      error?: Record<string, unknown> | null;
      attemptDelta?: number;
      now?: Date;
    },
    context: RequestContext,
  ): Promise<boolean>;
  listByJob(
    input: { teamId: string; jobId: string },
    context: RequestContext,
  ): Promise<
    Array<{
      operationId: string;
      operation: string;
      stage: string;
      resourceRef: { resourceType: string; resourceId: string; version: number };
    }>
  >;
  resetNextAttempt(
    input: { operationIds: string[]; now: Date },
    context: RequestContext,
  ): Promise<number>;
}

/** 删除事务/清理事实源（E1）。 */
export interface DeleteFactsStore {
  executeDeleteTransaction(
    input: {
      scope: DeleteScope;
      expectedVersion?: number;
      jobId?: string;
      ownerTmbId?: string;
      resourceIds?: { collectionIds?: string[]; dataIds?: string[] };
    },
    context: RequestContext,
  ): Promise<DeleteTransactionOutcome>;
  listObjectRefsForScope(scope: DeleteScope, context: RequestContext): Promise<ObjectRef[]>;
  listVectorDataIds(scope: DeleteScope, context: RequestContext): Promise<string[]>;
  hasLiveReference(
    input: { objectKey?: string; dataId?: string; datasetId?: string },
    context: RequestContext,
  ): Promise<boolean>;
}

export interface DeleteServiceDeps {
  jobs: DeleteJobStore;
  crossStore: CrossStoreStore;
  facts: DeleteFactsStore;
  queue: QueuePort;
  vectorController: VectorController;
  objectStore: ObjectStorePort;
  /** dataset 删除时清理同步调度（best-effort：失败仅由钩子内部记录日志，不阻塞响应）。 */
  syncSchedulerCleanup: (datasetId: string, context: RequestContext) => Promise<void>;
  clock?: () => Date;
  leaseOwner?: string;
  leaseMs?: number;
}

function decodeScope(jobId: string, fallbackDatasetId: string): DeleteScope {
  const segments = jobId.split(':');
  const datasetId = segments[1] ?? fallbackDatasetId;
  if (segments[2] === 'collection') {
    return { kind: 'collection', datasetId, collectionId: segments[3] ?? '' };
  }
  if (segments[2] === 'data') {
    return { kind: 'data', datasetId, dataId: segments[3] ?? '' };
  }
  return { kind: 'dataset', datasetId };
}

function stageIndex(stage: string): number {
  return DELETE_STAGES.indexOf(stage as (typeof DELETE_STAGES)[number]);
}

/**
 * 删除编排应用服务（设计 7.9 / 14.6）：
 * - 三类入口先做幂等判定（completed 幂等 / 进行中 501068 / failed 返回快照），
 *   再由事务事实源落库，提交后投递 BullMQ 并 CAS marked→queued；
 * - runCleanup 以租约+CAS 领取，按 vector→s3→verify 幂等清理；
 * - 失败写失败事实源并收敛到 failed；attempt≥10 不再重排（人工重试走 retryDeleteJob）。
 */
export class DeleteApplicationService {
  constructor(private readonly deps: DeleteServiceDeps) {}

  getDeleteJob(
    input: { jobId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<DeleteJobSnapshot> {
    return this.deps.jobs.get(input, context);
  }

  async getDeleteJobByScope(
    input: { scope: DeleteScope; options: PortCallOptions },
    context: RequestContext,
  ): Promise<DeleteJobScopeView | null> {
    const job = await this.deps.jobs.findByScope(
      {
        ...(input.scope.datasetId !== undefined ? { datasetId: input.scope.datasetId } : {}),
        ...(input.scope.collectionId !== undefined
          ? { collectionId: input.scope.collectionId }
          : {}),
        ...(input.scope.dataId !== undefined ? { dataId: input.scope.dataId } : {}),
        options: input.options,
      },
      context,
    );
    return job;
  }

  listFailures(
    input: { jobId: string; cursor?: string; limit: number; options: PortCallOptions },
    context: RequestContext,
  ): Promise<PageResult<{ resourceType: string; resourceId: string; reason: string }>> {
    return this.deps.jobs.listFailures(input, context);
  }

  retryJob(
    input: { jobId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<{ accepted: boolean }> {
    return this.deps.jobs.retry(input, context);
  }

  requestDatasetDelete(
    input: { datasetId: string; ownerTmbId?: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<DeleteRequestResult> {
    return this.requestDelete(
      { kind: 'dataset', datasetId: input.datasetId },
      input.options,
      context,
      input.ownerTmbId,
    );
  }

  requestCollectionDelete(
    input: { collectionId: string; ownerTmbId?: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<DeleteRequestResult> {
    return this.requestDelete(
      { kind: 'collection', collectionId: input.collectionId },
      input.options,
      context,
      input.ownerTmbId,
    );
  }

  requestDataDelete(
    input: { dataId: string; ownerTmbId?: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<DeleteRequestResult> {
    return this.requestDelete(
      { kind: 'data', dataId: input.dataId },
      input.options,
      context,
      input.ownerTmbId,
    );
  }

  /** Worker 清理运行器：租约领取 → vector → s3 → verify → completed。 */
  async runCleanup(
    input: { jobId: string; scope: DeleteScope; stage?: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<DeleteCleanupStats> {
    const scope = this.assertScope(input.scope, input.jobId);
    const now = this.now();
    const leaseOwner = this.deps.leaseOwner ?? `delete-${randomUUID()}`;
    const leaseMs = this.deps.leaseMs ?? DEFAULT_LEASE_MS;
    const claimed = await this.deps.jobs.claimWithLease(
      {
        jobId: input.jobId,
        leaseOwner,
        leaseMs,
        now,
      },
      context,
    );
    if (!claimed) {
      const current = await this.tryGetJob(input.jobId, input.options, context);
      if (current?.state === 'completed') {
        return { scanned: 0, deleted: 0, failed: 0, skipped: 0 };
      }
      if (current?.state === 'failed') {
        return {
          scanned: 0,
          deleted: 0,
          failed: 0,
          skipped: 1,
          errorMsg: 'dataset.delete.terminal_failed',
        };
      }
      throw deleteInProgress(input.jobId, current?.state ?? 'unknown', context.requestId);
    }

    let currentStage = claimed.stage;
    let scanned = 0;
    let deleted = 0;
    let skipped = 0;
    const advance = async (next: string): Promise<void> => {
      const from = stageIndex(currentStage);
      const to = stageIndex(next);
      if (to > from) assertStageOrder(currentStage, next, input.jobId);
      const updated = await this.deps.jobs.updateProgressGuarded(
        { jobId: input.jobId, leaseOwner, stage: next, now: this.now() },
        context,
      );
      if (!updated) throw leaseLost(input.jobId, context.requestId);
      currentStage = next;
    };
    const runFrom = async (stage: string, work: () => Promise<void>): Promise<void> => {
      const from = stageIndex(currentStage);
      const target = stageIndex(stage);
      if (from > target) return;
      if (from < target) await advance(stage);
      await work();
    };
    const renewLease = async (): Promise<void> => {
      const renewed = await this.deps.jobs.renewLease(
        { jobId: input.jobId, leaseOwner, leaseMs, now: this.now() },
        context,
      );
      if (!renewed) throw leaseLost(input.jobId, context.requestId);
    };

    try {
      await runFrom('vector', async () => {
        await renewLease();
        await this.deps.vectorController.delete(this.vectorInput(scope), context);
      });

      await runFrom('s3', async () => {
        await renewLease();
        const operations = await this.deps.crossStore.listByJob(
          { teamId: context.tenant.teamId, jobId: input.jobId },
          context,
        );
        const objectRefs = operations
          .filter((operation) => operation.operation === 'delete_s3')
          .map((operation) => ({ bucket: '', key: operation.resourceRef.resourceId }));
        scanned = objectRefs.length;
        for (const [index, ref] of objectRefs.entries()) {
          if (index > 0 && index % 50 === 0) await renewLease();
          const live = await this.deps.facts.hasLiveReference({ objectKey: ref.key }, context);
          if (live) {
            skipped += 1;
            continue;
          }
          const datasetId = datasetIdFromObjectKey(ref.key);
          const result = await this.deps.objectStore.delete(
            {
              ref,
              options: input.options,
              ...(datasetId !== undefined ? { datasetId } : {}),
            },
            context,
          );
          if (result.deleted) deleted += 1;
        }
      });

      await runFrom('verify', async () => {
        await renewLease();
      });
      await this.deps.jobs.transition(
        {
          jobId: input.jobId,
          expectedState: 'deleting',
          nextState: 'completed',
          stage: 'verify',
          progress: { total: scanned, done: deleted, failed: 0, skipped },
          options: input.options,
        },
        context,
      );
      return { scanned, deleted, failed: 0, skipped };
    } catch (error) {
      const retryable = classifyRetryableError(error) === 'retryable';
      const errorClass =
        error instanceof ApiErrorException
          ? error.error.messageKey
          : error instanceof Error
            ? error.name
            : typeof error;
      const lastError =
        error instanceof ApiErrorException
          ? `${error.error.code} ${error.error.messageKey}`
          : error instanceof Error
            ? error.message
            : String(error);
      await this.deps.jobs.recordFailure(
        {
          jobId: input.jobId,
          resourceType: scope.kind,
          resourceId: this.resourceIdOf(scope),
          stage: currentStage,
          attempt: claimed.attempt,
          errorClass,
          retryable,
          lastError,
        },
        context,
      );
      const operations = await this.deps.crossStore.listByJob(
        { teamId: context.tenant.teamId, jobId: input.jobId },
        context,
      );
      for (const operation of operations) {
        await this.deps.crossStore.markStage(
          {
            operationId: operation.operationId,
            stage: 'failed',
            error: { errorClass, lastError },
            now: this.now(),
          },
          context,
        );
      }
      await this.deps.jobs.transition(
        {
          jobId: input.jobId,
          expectedState: 'deleting',
          nextState: 'failed',
          stage: currentStage,
          progress: { total: scanned, done: deleted, failed: 1, skipped },
          options: input.options,
        },
        context,
      );
      if (retryable && claimed.attempt < MAX_DELETE_ATTEMPTS) {
        await this.deps.jobs.resetRetry({ jobId: input.jobId }, context);
        throw error;
      }
      return {
        scanned,
        deleted,
        failed: 1,
        skipped,
        errorMsg: `dataset.delete.failed:${lastError}`,
      };
    }
  }

  /** 人工恢复：仅重排失败资源，不覆盖已提交事实；无失败项返回 501040。 */
  async retryDeleteJob(
    input: { jobId: string; options: PortCallOptions },
    context: RequestContext,
  ): Promise<DeleteRequestResult> {
    const current = await this.deps.jobs.get(
      { jobId: input.jobId, options: input.options },
      context,
    );
    if (!canRetryDeleteJob(current.state) || current.failureCount === 0) {
      throw noFailureToRetry(input.jobId, context.requestId);
    }
    const reset = await this.deps.jobs.resetRetry({ jobId: input.jobId }, context);
    if (!reset) throw noFailureToRetry(input.jobId, context.requestId);
    const operations = await this.deps.crossStore.listByJob(
      { teamId: context.tenant.teamId, jobId: input.jobId },
      context,
    );
    await this.deps.crossStore.resetNextAttempt(
      { operationIds: operations.map((operation) => operation.operationId), now: this.now() },
      context,
    );
    const scope = decodeScope(input.jobId, current.datasetId);
    await this.deps.queue.enqueue(QUEUE_NAMES.delete, input.jobId, {
      jobId: input.jobId,
      scope,
      stage: 'vector',
    });
    return { jobId: input.jobId, state: 'queued' };
  }

  private async requestDelete(
    scope: DeleteScope,
    options: PortCallOptions,
    context: RequestContext,
    ownerTmbId?: string,
  ): Promise<DeleteRequestResult> {
    const knownJobId =
      scope.kind === 'dataset' && scope.datasetId !== undefined
        ? buildDeleteJobId(context.tenant.teamId, scope.datasetId)
        : undefined;
    if (knownJobId !== undefined) {
      const existing = await this.tryGetJob(knownJobId, options, context);
      if (existing) return this.existingResult(existing, context.requestId);
    }

    const transaction = await this.deps.facts.executeDeleteTransaction(
      {
        scope,
        ...(knownJobId !== undefined ? { jobId: knownJobId } : {}),
        ...(ownerTmbId !== undefined ? { ownerTmbId } : {}),
      },
      context,
    );
    if (transaction.existing) {
      if (transaction.state === 'completed' || transaction.state === 'failed') {
        return { jobId: transaction.deleteJobId, state: transaction.state };
      }
      throw deleteInProgress(transaction.deleteJobId, transaction.state, context.requestId);
    }

    const payloadScope: DeleteScope = {
      kind: scope.kind,
      datasetId: transaction.datasetId,
      ...(scope.collectionId !== undefined ? { collectionId: scope.collectionId } : {}),
      ...(scope.dataId !== undefined ? { dataId: scope.dataId } : {}),
    };
    try {
      await this.deps.queue.enqueue(QUEUE_NAMES.delete, transaction.deleteJobId, {
        jobId: transaction.deleteJobId,
        scope: payloadScope,
        stage: 'vector',
      });
    } catch {
      throw new ApiErrorException(createInternalError('delete.enqueue', context.requestId));
    }
    await this.deps.jobs.transition(
      {
        jobId: transaction.deleteJobId,
        expectedState: 'marked',
        nextState: 'queued',
        options,
      },
      context,
    );
    if (scope.kind === 'dataset') {
      try {
        await this.deps.syncSchedulerCleanup(transaction.datasetId, context);
      } catch {
        // best-effort：清理钩子内部记录日志，失败不阻塞删除受理响应。
      }
    }
    return { jobId: transaction.deleteJobId, state: 'queued' };
  }

  private existingResult(job: DeleteJobSnapshot, requestId: string): DeleteRequestResult {
    if (job.state === 'completed' || job.state === 'failed') {
      return { jobId: job.jobId, state: job.state };
    }
    throw deleteInProgress(job.jobId, job.state, requestId);
  }

  private async tryGetJob(
    jobId: string,
    options: PortCallOptions,
    context: RequestContext,
  ): Promise<DeleteJobSnapshot | null> {
    try {
      return await this.deps.jobs.get({ jobId, options }, context);
    } catch (error) {
      if (error instanceof ApiErrorException && error.error.code === 501070) return null;
      throw error;
    }
  }

  private vectorInput(scope: DeleteScope): {
    dataIds?: string[];
    datasetId?: string;
    collectionId?: string;
    options: PortCallOptions;
  } {
    const options = { timeoutMs: DEFAULT_TIMEOUT_MS };
    if (scope.kind === 'data' && scope.dataId !== undefined) {
      return { datasetId: scope.datasetId, dataIds: [scope.dataId], options };
    }
    if (scope.kind === 'collection' && scope.collectionId !== undefined) {
      return {
        datasetId: scope.datasetId,
        collectionId: scope.collectionId,
        options,
      };
    }
    return { datasetId: scope.datasetId, options };
  }

  private resourceIdOf(scope: DeleteScope): string {
    return scope.dataId ?? scope.collectionId ?? scope.datasetId ?? '';
  }

  private assertScope(scope: DeleteScope | null | undefined, jobId: string): DeleteScope {
    if (
      !scope ||
      (scope.kind !== 'dataset' && scope.kind !== 'collection' && scope.kind !== 'data') ||
      (scope.datasetId === undefined &&
        scope.collectionId === undefined &&
        scope.dataId === undefined)
    ) {
      throw new ApiErrorException(
        createApiError({
          code: 501005,
          requestId: jobId,
          params: { taskId: jobId, from: 'payload', to: 'invalid_scope' },
        }),
      );
    }
    return scope;
  }

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }
}

function deleteInProgress(jobId: string, state: string, requestId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({ code: 501068, requestId, params: { jobId, state } }),
  );
}

function noFailureToRetry(jobId: string, requestId: string): ApiErrorException {
  return new ApiErrorException(createApiError({ code: 501040, requestId, params: { jobId } }));
}

function datasetIdFromObjectKey(objectKey: string): string | undefined {
  const [prefix, datasetId] = objectKey.split('/');
  return prefix === 'dataset' && datasetId !== undefined && datasetId !== ''
    ? datasetId
    : undefined;
}

function leaseLost(jobId: string, requestId: string): ApiErrorException {
  return new ApiErrorException(
    createApiError({
      code: 501005,
      requestId,
      params: { taskId: jobId, from: 'lease', to: 'lost' },
    }),
  );
}
