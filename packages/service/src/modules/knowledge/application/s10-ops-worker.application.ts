import { createKnowledgeError, KnowledgeApiError } from '@kb/contracts';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { KnowledgeJobDoc } from '../../../shared/persistence/schemas/knowledge-job.schemas';

export interface S10WorkerJobPort {
  claimById(
    input: { jobId: string; kinds: readonly KnowledgeJobDoc['kind'][]; workerId: string },
    context: TenantContext,
  ): Promise<unknown>;
  getRaw(
    jobId: string,
    context: TenantContext,
  ): Promise<{
    version: number;
    kind: KnowledgeJobDoc['kind'];
    inputSnapshot: Record<string, unknown>;
    fencingToken: string;
    attemptEpoch: number;
  }>;
  start(
    jobId: string,
    expectedVersion: number,
    attemptEpoch: number,
    fencingToken: string,
    workerId: string,
    context: TenantContext,
  ): Promise<{ version: number }>;
  setStep(
    input: {
      jobId: string;
      stepKey: string;
      status: 'running' | 'succeeded' | 'failed' | 'skipped';
      idempotencyKey: string;
      evidence?: Record<string, unknown> | null;
    },
    context: TenantContext,
  ): Promise<unknown>;
  commit(
    jobId: string,
    expectedVersion: number,
    attemptEpoch: number,
    fencingToken: string,
    workerId: string,
    result: Record<string, unknown>,
    context: TenantContext,
  ): Promise<{ status: string; result: Record<string, unknown> | null }>;
  fail(
    jobId: string,
    expectedVersion: number,
    attemptEpoch: number,
    fencingToken: string,
    workerId: string,
    retryable: boolean,
    errorCode: string,
    context: TenantContext,
  ): Promise<unknown>;
}

export interface S10OpsResult {
  diffCount: number;
  repairedCount: number;
  retryable: number;
  deadLetter: number;
  items: Array<Record<string, unknown>>;
  startedAt: string;
  finishedAt: string;
}

export interface S10OpsWorkerDependencies {
  jobs: S10WorkerJobPort;
  deliverUsage?(input: {
    outboxEventId: string;
    eventId: string;
    payload: Record<string, unknown>;
    context: TenantContext;
  }): Promise<void>;
  cleanup(input: {
    jobId: string;
    scope: string;
    context: TenantContext;
    step: (
      key: string,
      status: 'running' | 'succeeded' | 'failed' | 'skipped',
      evidence: Record<string, unknown>,
    ) => Promise<void>;
  }): Promise<S10OpsResult>;
  reconcile(input: {
    jobId: string;
    scope: string;
    repair: boolean;
    context: TenantContext;
    step: (
      key: string,
      status: 'running' | 'succeeded' | 'failed' | 'skipped',
      evidence: Record<string, unknown>,
    ) => Promise<void>;
  }): Promise<S10OpsResult>;
  replay(input: { jobId: string; context: TenantContext }): Promise<{
    diffCount: number;
    repairedCount: number;
    retryable: number;
    deadLetter: number;
    items: Array<Record<string, unknown>>;
  }>;
}

export class S10OpsWorkerApplication {
  constructor(private readonly input: S10OpsWorkerDependencies) {}

  async handleUsageOutbox(input: {
    outboxEventId: string;
    payload: Record<string, unknown>;
    context: TenantContext;
  }): Promise<void> {
    const eventId = input.payload.usageEventId;
    if (typeof eventId !== 'string' || eventId.length === 0) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: input.context.requestId,
        traceId: input.context.traceId,
        details: { field: 'usageEventId', reason: 'required' },
      });
    }
    if (!this.input.deliverUsage) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
        requestId: input.context.requestId,
        traceId: input.context.traceId,
        retryable: false,
        details: { dependency: 'shared_usage', reason: 'delivery_not_configured' },
      });
    }
    await this.input.deliverUsage({
      outboxEventId: input.outboxEventId,
      eventId,
      payload: input.payload,
      context: input.context,
    });
  }

  async handleQueue(
    jobId: string,
    queueName: 'knowledge-cleanup' | 'knowledge-outbox',
    workerId: string,
    context: TenantContext,
  ): Promise<{ status: string; result: Record<string, unknown> | null }> {
    const kinds =
      queueName === 'knowledge-outbox'
        ? (['outbox'] as const)
        : (['cleanup', 'reconcile'] as const);
    const claimed = await this.input.jobs.claimById(
      { jobId, kinds: [...kinds], workerId },
      context,
    );
    if (!claimed) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_JOB_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { jobId, reason: 'not_claimable' },
      });
    }
    const raw = await this.input.jobs.getRaw(jobId, context);
    const fencingToken = raw.fencingToken;
    const attemptEpoch = raw.attemptEpoch;
    const running = await this.input.jobs.start(
      jobId,
      raw.version,
      attemptEpoch,
      fencingToken,
      workerId,
      context,
    );
    const step = async (
      key: string,
      status: 'running' | 'succeeded' | 'failed' | 'skipped',
      evidence: Record<string, unknown>,
    ) => {
      await this.input.jobs.setStep(
        {
          jobId,
          stepKey: key,
          status,
          idempotencyKey: `${jobId}:${key}:${status}`,
          evidence,
        },
        context,
      );
    };
    const startedAt = new Date().toISOString();
    try {
      let result: S10OpsResult;
      if (raw.kind === 'cleanup') {
        result = await this.input.cleanup({
          jobId,
          scope: String(raw.inputSnapshot.scope ?? 'all'),
          context,
          step,
        });
      } else if (raw.kind === 'reconcile') {
        result = await this.input.reconcile({
          jobId,
          scope: String(raw.inputSnapshot.scope ?? 'all'),
          repair: raw.inputSnapshot.repair === true,
          context,
          step,
        });
      } else {
        const replay = await this.input.replay({ jobId, context });
        result = {
          ...replay,
          startedAt,
          finishedAt: new Date().toISOString(),
        };
      }
      const committed = await this.input.jobs.commit(
        jobId,
        running.version,
        attemptEpoch,
        fencingToken,
        workerId,
        result as unknown as Record<string, unknown>,
        context,
      );
      return { status: committed.status, result: committed.result };
    } catch (error) {
      const code =
        error instanceof KnowledgeApiError ? error.problem.error.code : 'KNOWLEDGE_INTERNAL_ERROR';
      const retryable = error instanceof KnowledgeApiError ? error.problem.error.retryable : true;
      await this.input.jobs.fail(
        jobId,
        running.version,
        attemptEpoch,
        fencingToken,
        workerId,
        retryable,
        code,
        context,
      );
      throw error;
    }
  }
}
