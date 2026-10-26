import { randomUUID } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import type { ClientSession, Types, Connection, Model } from 'mongoose';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type {
  KnowledgeJobDoc,
  KnowledgeJobStepDoc,
} from '../../../shared/persistence/schemas/knowledge-job.schemas';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import {
  KnowledgeAuditRepository,
  type KnowledgeAuditInput,
} from '../../../shared/persistence/knowledge/audit';
import { withMongoTransaction } from '../../../shared/persistence/with-mongo-transaction';
import {
  objectIdOf,
  requireWorkspaceId,
  tenantError,
} from '../../../shared/persistence/knowledge/tenant';
import { assertJobTransition, type JobState } from '../domain/job-state';
import {
  cursorFilter,
  decodeCursor,
  encodeCursor,
  parseLimit,
  parseSort,
  type PageRequest,
} from './pagination';

type Plain<T> = T & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

function jobDto(document: Plain<KnowledgeJobDoc>, steps: Plain<KnowledgeJobStepDoc>[] = []) {
  return {
    jobId: String(document._id),
    workspaceId: document.workspaceId,
    knowledgeSpaceId: document.knowledgeSpaceId
      ? String(document.knowledgeSpaceId)
      : '000000000000000000000000',
    kind: document.kind,
    status: document.status,
    priority: document.priority,
    attempts: document.attempts,
    maxAttempts: document.maxAttempts,
    progress: document.progress,
    steps: steps.map((step) => ({
      stepKey: step.stepKey,
      status: step.status,
      attempts: step.attempts,
      externalEvidence: step.externalEvidence,
      compensationState: step.compensationState,
    })),
    error: document.error,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
}

export class KnowledgeJobRepository {
  private readonly jobs: Model<KnowledgeJobDoc>;
  private readonly steps: Model<KnowledgeJobStepDoc>;
  private readonly audit: KnowledgeAuditRepository;

  constructor(private readonly connection: Connection) {
    const models = registerKnowledgeModels(connection);
    this.jobs = models.KnowledgeJob as Model<KnowledgeJobDoc>;
    this.steps = models.KnowledgeJobStep as Model<KnowledgeJobStepDoc>;
    this.audit = new KnowledgeAuditRepository(connection);
  }

  async list(query: PageRequest, context: TenantContext) {
    requireWorkspaceId(context);
    const limit = parseLimit(query.limit, context);
    const sort = parseSort(query.sort, context);
    const cursor = decodeCursor(query.cursor, context);
    const docs = (await this.jobs
      .find({
        workspaceId: context.workspaceId,
        deletedAt: null,
        ...cursorFilter(sort, cursor),
      })
      .sort({ [sort.field]: sort.direction, _id: sort.direction })
      .limit(limit + 1)
      .lean()) as unknown as Plain<KnowledgeJobDoc>[];
    const hasMore = docs.length > limit;
    const visible = docs.slice(0, limit);
    const stepDocs = (await this.steps
      .find({
        workspaceId: context.workspaceId,
        deletedAt: null,
        jobId: { $in: visible.map((doc) => doc._id) },
      })
      .sort({ createdAt: 1 })
      .lean()) as unknown as Plain<KnowledgeJobStepDoc>[];
    return {
      items: visible.map((doc) =>
        jobDto(
          doc,
          stepDocs.filter((step) => String(step.jobId) === String(doc._id)),
        ),
      ),
      pageInfo: {
        hasMore,
        nextCursor:
          hasMore && visible.at(-1)
            ? encodeCursor(sort, visible.at(-1) as Plain<KnowledgeJobDoc> & Record<string, unknown>)
            : null,
      },
    };
  }

  async get(jobId: string, context: TenantContext) {
    requireWorkspaceId(context);
    const id = objectIdOf(jobId, context, 'jobId');
    const doc = (await this.jobs
      .findOne({
        workspaceId: context.workspaceId,
        _id: id,
        deletedAt: null,
      })
      .lean()) as unknown as Plain<KnowledgeJobDoc> | null;
    if (!doc) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
    const stepDocs = (await this.steps
      .find({
        workspaceId: context.workspaceId,
        jobId: id,
        deletedAt: null,
      })
      .sort({ createdAt: 1 })
      .lean()) as unknown as Plain<KnowledgeJobStepDoc>[];
    return jobDto(doc, stepDocs);
  }

  async claim(
    input: {
      kinds?: KnowledgeJobDoc['kind'][];
      workerId: string;
      leaseMs?: number;
    },
    context: TenantContext,
  ): Promise<ReturnType<typeof jobDto> | null> {
    requireWorkspaceId(context);
    const now = new Date();
    const leaseMs = input.leaseMs ?? 300_000;
    const job = await this.jobs.findOneAndUpdate(
      {
        workspaceId: context.workspaceId,
        deletedAt: null,
        status: 'queued',
        availableAt: { $lte: now },
        ...(input.kinds?.length ? { kind: { $in: input.kinds } } : {}),
      },
      {
        $set: {
          status: 'leased',
          leaseOwner: input.workerId,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          heartbeatAt: now,
          fencingToken: randomUUID(),
          updatedByMemberId: context.memberId,
        },
        $inc: {
          version: 1,
          attempts: 1,
          attemptEpoch: 1,
        },
      },
      { new: true, sort: { priority: -1, availableAt: 1 } },
    );
    return job ? jobDto(job.toObject() as unknown as Plain<KnowledgeJobDoc>) : null;
  }

  async heartbeat(
    input: {
      jobId: string;
      workerId: string;
      attemptEpoch: number;
      fencingToken: string;
      expectedVersion: number;
      leaseMs?: number;
    },
    context: TenantContext,
  ): Promise<ReturnType<typeof jobDto>> {
    requireWorkspaceId(context);
    const now = new Date();
    const updated = await this.jobs.findOneAndUpdate(
      {
        _id: objectIdOf(input.jobId, context, 'jobId'),
        workspaceId: context.workspaceId,
        version: input.expectedVersion,
        status: { $in: ['leased', 'running'] },
        leaseOwner: input.workerId,
        attemptEpoch: input.attemptEpoch,
        fencingToken: input.fencingToken,
        deletedAt: null,
      },
      {
        $set: {
          heartbeatAt: now,
          leaseExpiresAt: new Date(now.getTime() + (input.leaseMs ?? 300_000)),
          updatedByMemberId: context.memberId,
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    if (!updated) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_JOB_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'lease_lost', jobId: input.jobId },
      });
    }
    return jobDto(updated.toObject() as unknown as Plain<KnowledgeJobDoc>);
  }

  async start(
    input: {
      jobId: string;
      workerId: string;
      attemptEpoch: number;
      fencingToken: string;
      expectedVersion: number;
    },
    context: TenantContext,
  ): Promise<ReturnType<typeof jobDto>> {
    requireWorkspaceId(context);
    return this.transitionLeased(input, 'running', context, 'running', {
      stage: 'running',
      completed: 0,
      total: 1,
      percent: 0,
    });
  }

  async commit(
    input: {
      jobId: string;
      workerId: string;
      attemptEpoch: number;
      fencingToken: string;
      expectedVersion: number;
      result: Record<string, unknown>;
      audit?: KnowledgeAuditInput;
    },
    context: TenantContext,
  ): Promise<ReturnType<typeof jobDto>> {
    requireWorkspaceId(context);
    const run = async (session?: ClientSession) => {
      const now = new Date();
      const updated = await this.jobs.findOneAndUpdate(
        {
          _id: objectIdOf(input.jobId, context, 'jobId'),
          workspaceId: context.workspaceId,
          version: input.expectedVersion,
          status: 'running',
          leaseOwner: input.workerId,
          attemptEpoch: input.attemptEpoch,
          fencingToken: input.fencingToken,
          leaseExpiresAt: { $gt: now },
          deletedAt: null,
        },
        {
          $set: {
            status: 'succeeded',
            result: input.result,
            progress: { stage: 'succeeded', completed: 1, total: 1, percent: 100 },
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
        { new: true, ...(session ? { session } : {}) },
      );
      if (!updated) {
        throw createKnowledgeError({
          code: 'KNOWLEDGE_JOB_FAILED',
          requestId: context.requestId,
          traceId: context.traceId,
          details: { reason: 'stale_fencing_token', jobId: input.jobId },
        });
      }
      if (input.audit) {
        if (!session) throw tenantError(context);
        await this.audit.append(input.audit, context, session);
      }
      return jobDto(updated.toObject() as unknown as Plain<KnowledgeJobDoc>);
    };
    return input.audit ? withMongoTransaction(this.connection, (session) => run(session)) : run();
  }

  async fail(
    input: {
      jobId: string;
      workerId: string;
      attemptEpoch: number;
      fencingToken: string;
      expectedVersion: number;
      retryable: boolean;
    },
    context: TenantContext,
  ): Promise<ReturnType<typeof jobDto>> {
    requireWorkspaceId(context);
    const current = await this.jobs.findOne({
      _id: objectIdOf(input.jobId, context, 'jobId'),
      workspaceId: context.workspaceId,
      version: input.expectedVersion,
      status: { $in: ['leased', 'running'] },
      leaseOwner: input.workerId,
      attemptEpoch: input.attemptEpoch,
      fencingToken: input.fencingToken,
      deletedAt: null,
    });
    if (!current) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_JOB_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'stale_fencing_token', jobId: input.jobId },
      });
    }
    const next: JobState =
      input.retryable && current.attempts < current.maxAttempts
        ? 'retry_wait'
        : current.attempts >= current.maxAttempts
          ? 'dead_letter'
          : 'failed';
    assertJobTransition(current.status, next, context);
    const updated = await this.jobs.findOneAndUpdate(
      { _id: current._id, workspaceId: context.workspaceId, version: current.version },
      {
        $set: {
          status: next,
          error: { code: 'KNOWLEDGE_JOB_FAILED', retryable: input.retryable },
          leaseOwner: null,
          leaseExpiresAt: null,
          availableAt:
            next === 'retry_wait'
              ? new Date(Date.now() + 2 ** current.attempts * 1000)
              : current.availableAt,
          updatedByMemberId: context.memberId,
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    if (!updated) throw tenantError(context, 'KNOWLEDGE_CONFLICT');
    return jobDto(updated.toObject() as unknown as Plain<KnowledgeJobDoc>);
  }

  async transition(
    input: {
      jobId: string;
      expectedVersion: number;
      nextStatus: JobState;
      workerId?: string;
      attemptEpoch?: number;
      fencingToken?: string;
    },
    context: TenantContext,
  ): Promise<ReturnType<typeof jobDto>> {
    requireWorkspaceId(context);
    const current = await this.jobs.findOne({
      _id: objectIdOf(input.jobId, context, 'jobId'),
      workspaceId: context.workspaceId,
      version: input.expectedVersion,
      deletedAt: null,
    });
    if (!current) throw tenantError(context, 'KNOWLEDGE_CONFLICT');
    assertJobTransition(current.status, input.nextStatus, context);
    const updated = await this.jobs.findOneAndUpdate(
      { _id: current._id, workspaceId: context.workspaceId, version: current.version },
      {
        $set: {
          status: input.nextStatus,
          ...(input.nextStatus === 'paused' ? { pausedAt: new Date() } : {}),
          ...(input.nextStatus === 'cancelling' ? { cancelRequestedAt: new Date() } : {}),
          ...(input.nextStatus === 'queued'
            ? {
                availableAt: new Date(),
                leaseOwner: null,
                leaseExpiresAt: null,
              }
            : {}),
          updatedByMemberId: context.memberId,
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    if (!updated) throw tenantError(context, 'KNOWLEDGE_CONFLICT');
    return jobDto(updated.toObject() as unknown as Plain<KnowledgeJobDoc>);
  }

  private async transitionLeased(
    input: {
      jobId: string;
      workerId: string;
      attemptEpoch: number;
      fencingToken: string;
      expectedVersion: number;
    },
    nextStatus: JobState,
    context: TenantContext,
    stage: string,
    progress: Record<string, unknown>,
  ) {
    const updated = await this.jobs.findOneAndUpdate(
      {
        _id: objectIdOf(input.jobId, context, 'jobId'),
        workspaceId: context.workspaceId,
        version: input.expectedVersion,
        status: 'leased',
        leaseOwner: input.workerId,
        attemptEpoch: input.attemptEpoch,
        fencingToken: input.fencingToken,
        leaseExpiresAt: { $gt: new Date() },
        deletedAt: null,
      },
      {
        $set: {
          status: nextStatus,
          progress: { stage, ...progress },
          updatedByMemberId: context.memberId,
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    if (!updated) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_JOB_FAILED',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'lease_lost', jobId: input.jobId },
      });
    }
    return jobDto(updated.toObject() as unknown as Plain<KnowledgeJobDoc>);
  }
}
