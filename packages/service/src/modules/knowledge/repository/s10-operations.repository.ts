import { createHash } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import { buildKnowledgeJobId, type QueuePort } from '@kb/dal';
import { Types, type ClientSession, type Connection, type Model } from 'mongoose';
import type {
  S10AuditListQuery,
  S10AuditQueryPort,
  S10AuditView,
  S10OpsJobView,
  S10OpsRepositoryPort,
} from '../application/s10-operations.ports';
import { KnowledgeAuditRepository } from '../../../shared/persistence/knowledge/audit';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import {
  objectIdOf,
  requireWorkspaceId,
  tenantError,
} from '../../../shared/persistence/knowledge/tenant';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type {
  KnowledgeJobDoc,
  KnowledgeOutboxEventDoc,
} from '../../../shared/persistence/schemas/knowledge-job.schemas';
import type { KnowledgeAuditEventDoc } from '../../../shared/persistence/schemas/knowledge-operations.schemas';
import { KnowledgeJobExecutionRepository } from './job-execution.repository';
import { parseLimit } from './pagination';
import { withMongoTransaction } from '../../../shared/persistence/with-mongo-transaction';

type PlainAudit = KnowledgeAuditEventDoc & { _id: Types.ObjectId };
type PlainJob = KnowledgeJobDoc & { _id: Types.ObjectId };

const EMPTY_OBJECT_ID = '000000000000000000000000';

interface AuditCursor {
  occurredAt: string;
  id: string;
}

function auditView(document: PlainAudit): S10AuditView {
  return {
    eventId: document.eventId,
    workspaceId: document.workspaceId,
    knowledgeSpaceId: document.knowledgeSpaceId ? String(document.knowledgeSpaceId) : null,
    action: document.action,
    actorMemberId: document.actorMemberId,
    apiKeyId: document.apiKeyId ? String(document.apiKeyId) : null,
    apiKeyPrefix: document.apiKeyPrefix ?? null,
    resourceType: document.resourceType,
    resourceId: document.resourceId,
    outcome: document.outcome,
    traceId: document.traceId,
    requestId: document.requestId,
    ipHash: document.ipHash,
    userAgentHash: document.userAgentHash,
    safeDiff: document.safeDiff,
    occurredAt: document.occurredAt.toISOString(),
    expiresAt: document.expiresAt.toISOString(),
  };
}

function decodeAuditCursor(value: string | undefined, context: TenantContext): AuditCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as AuditCursor;
    if (
      typeof parsed.occurredAt !== 'string' ||
      Number.isNaN(new Date(parsed.occurredAt).getTime()) ||
      !Types.ObjectId.isValid(parsed.id)
    ) {
      throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
        field: 'cursor',
        reason: 'invalid',
      });
    }
    return parsed;
  } catch {
    throw tenantError(context, 'KNOWLEDGE_VALIDATION_FAILED', {
      field: 'cursor',
      reason: 'invalid',
    });
  }
}

function jobResponse(document: PlainJob, operationId: string): S10OpsJobView {
  const progress = document.progress as Partial<{
    stage: unknown;
    completed: unknown;
    total: unknown;
    percent: unknown;
  }>;
  return {
    jobId: String(document._id),
    workspaceId: document.workspaceId,
    knowledgeSpaceId: document.knowledgeSpaceId
      ? String(document.knowledgeSpaceId)
      : EMPTY_OBJECT_ID,
    kind: document.kind as S10OpsJobView['kind'],
    status: document.status,
    operationId,
    priority: document.priority,
    attempts: document.attempts,
    maxAttempts: document.maxAttempts,
    progress: {
      stage: typeof progress.stage === 'string' ? progress.stage : 'queued',
      completed: Number.isFinite(Number(progress.completed)) ? Number(progress.completed) : 0,
      total: Number.isFinite(Number(progress.total)) ? Number(progress.total) : 1,
      percent: Number.isFinite(Number(progress.percent)) ? Number(progress.percent) : 0,
    },
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
    resourceType: document.resourceType as S10OpsJobView['resourceType'],
    resourceId: Types.ObjectId.isValid(document.resourceId) ? document.resourceId : EMPTY_OBJECT_ID,
    version: document.version,
  };
}

function batchHash(input: {
  workspaceId: string;
  operationId: string;
  scope: string;
  repair?: boolean;
}): string {
  return createHash('sha256')
    .update(
      [
        input.workspaceId,
        input.operationId,
        input.scope,
        String(input.repair ?? false),
        'batchSize=500',
        'retentionDays=30',
      ].join('|'),
    )
    .digest('hex');
}

export class S10OperationsRepository implements S10AuditQueryPort, S10OpsRepositoryPort {
  private readonly audits: Model<KnowledgeAuditEventDoc>;
  private readonly jobs: Model<KnowledgeJobDoc>;
  private readonly outbox: Model<KnowledgeOutboxEventDoc>;
  private readonly auditRepository: KnowledgeAuditRepository;
  private readonly jobExecution: KnowledgeJobExecutionRepository;

  constructor(
    private readonly connection: Connection,
    private readonly queue: QueuePort,
  ) {
    const models = registerKnowledgeModels(connection);
    this.audits = models.KnowledgeAuditEvent;
    this.jobs = models.KnowledgeJob;
    this.outbox = models.KnowledgeOutboxEvent;
    this.auditRepository = new KnowledgeAuditRepository(connection);
    this.jobExecution = new KnowledgeJobExecutionRepository(connection);
  }

  async list(
    query: S10AuditListQuery,
    context: TenantContext,
  ): Promise<{ items: S10AuditView[]; pageInfo: { nextCursor: string | null; hasMore: boolean } }> {
    const limit = parseLimit(query.limit, context);
    const cursor = decodeAuditCursor(query.cursor, context);
    const cursorDate = cursor ? new Date(cursor.occurredAt) : null;
    const documents = (await this.audits
      .find({
        workspaceId: requireWorkspaceId(context),
        deletedAt: null,
        ...(query.action ? { action: query.action } : {}),
        ...(query.actor ? { actorMemberId: query.actor } : {}),
        ...(query.resourceType ? { resourceType: query.resourceType } : {}),
        ...(query.resourceId ? { resourceId: query.resourceId } : {}),
        ...(query.outcome ? { outcome: query.outcome } : {}),
        ...(query.from || query.to
          ? {
              occurredAt: {
                ...(query.from ? { $gte: query.from } : {}),
                ...(query.to ? { $lte: query.to } : {}),
              },
            }
          : {}),
        ...(cursor && cursorDate
          ? {
              $or: [
                { occurredAt: { $lt: cursorDate } },
                {
                  occurredAt: cursorDate,
                  _id: { $lt: new Types.ObjectId(cursor.id) },
                },
              ],
            }
          : {}),
      })
      .sort({ occurredAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean()) as unknown as PlainAudit[];
    const hasMore = documents.length > limit;
    const page = hasMore ? documents.slice(0, limit) : documents;
    const last = page.at(-1);
    return {
      items: page.map(auditView),
      pageInfo: {
        hasMore,
        nextCursor:
          hasMore && last
            ? Buffer.from(
                JSON.stringify({
                  occurredAt: last.occurredAt.toISOString(),
                  id: String(last._id),
                }),
                'utf8',
              ).toString('base64url')
            : null,
      },
    };
  }

  private async createJob(
    input: {
      kind: 'cleanup' | 'reconcile' | 'outbox';
      operationId: string;
      scope: string;
      idempotencyKey: string;
      batchKey: string;
      repair?: boolean;
      outboxEventId?: string;
    },
    context: TenantContext,
    session: ClientSession,
  ): Promise<PlainJob> {
    const existing = (await this.jobs
      .findOne({
        workspaceId: requireWorkspaceId(context),
        idempotencyKey: input.idempotencyKey,
        deletedAt: null,
      })
      .session(session)
      .lean()) as unknown as PlainJob | null;
    if (existing) {
      if (existing.kind !== input.kind) throw tenantError(context, 'KNOWLEDGE_CONFLICT');
      return existing;
    }
    const [created] = await this.jobs.create(
      [
        {
          workspaceId: requireWorkspaceId(context),
          knowledgeSpaceId: null,
          version: 1,
          deletedAt: null,
          createdByMemberId: context.memberId,
          updatedByMemberId: context.memberId,
          kind: input.kind,
          resourceType: input.kind === 'outbox' ? 'system' : 'workspace',
          resourceId: input.outboxEventId ?? EMPTY_OBJECT_ID,
          status: 'queued',
          priority: 5,
          idempotencyKey: input.idempotencyKey,
          inputSnapshot: {
            operationId: input.operationId,
            scope: input.scope,
            batchSize: 500,
            retentionDays: 30,
            batchKey: input.batchKey,
            workspaceId: context.workspaceId,
            repair: input.repair ?? false,
            ...(input.outboxEventId ? { outboxEventId: input.outboxEventId } : {}),
          },
          progress: { stage: 'queued', completed: 0, total: 1, percent: 0 },
          attempts: 0,
          maxAttempts: 5,
          attemptEpoch: 0,
          fencingToken: 'unassigned',
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          availableAt: new Date(),
          cancelRequestedAt: null,
          pausedAt: null,
          error: null,
          result: null,
          expiresAt: new Date(Date.now() + 180 * 86_400_000),
        },
      ],
      { session },
    );
    if (!created) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_INTERNAL_ERROR',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 's10_job_create_failed' },
      });
    }
    const object = created.toObject() as PlainJob;
    await this.auditRepository.append(
      {
        knowledgeSpaceId: null,
        action: `${input.kind}.queued`,
        resourceType: 'job',
        resourceId: String(object._id),
        outcome: 'succeeded',
        safeDiff: {
          scope: input.scope,
          repair: input.repair ?? false,
          batchKey: input.batchKey,
        },
      },
      context,
      session,
    );
    return object;
  }

  private async enqueue(
    job: PlainJob,
    queueName: 'knowledge-cleanup' | 'knowledge-outbox',
    context: TenantContext,
  ): Promise<void> {
    const queueJobId = buildKnowledgeJobId({
      kind: job.kind,
      resourceId: String(job._id),
      version: job.version,
      inputHash: createHash('sha256').update(JSON.stringify(job.inputSnapshot)).digest('hex'),
    });
    try {
      await this.queue.enqueue(
        queueName,
        queueJobId,
        {
          jobId: String(job._id),
          workspaceId: context.workspaceId,
          ...(job.kind === 'outbox'
            ? { outboxEventId: String(job.inputSnapshot.outboxEventId) }
            : {}),
        },
        { attempts: 5, backoff: { type: 'exponential', delay: 1_000 } },
      );
    } catch {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { dependency: 'queue', operation: 's10_ops_enqueue', jobId: String(job._id) },
      });
    }
  }

  async createCleanupJob(
    input: { scope: string; idempotencyKey: string },
    context: TenantContext,
  ): Promise<S10OpsJobView> {
    const job = await withMongoTransaction(this.connection, (session) =>
      this.createJob(
        {
          kind: 'cleanup',
          operationId: 'API-OPS-CLEANUP',
          scope: input.scope,
          idempotencyKey: input.idempotencyKey,
          batchKey: batchHash({
            workspaceId: context.workspaceId,
            operationId: 'API-OPS-CLEANUP',
            scope: input.scope,
          }),
        },
        context,
        session,
      ),
    );
    await this.enqueue(job, 'knowledge-cleanup', context);
    return jobResponse(job, 'API-OPS-CLEANUP');
  }

  async createReconcileJob(
    input: { scope: string; repair: boolean; idempotencyKey: string },
    context: TenantContext,
  ): Promise<S10OpsJobView> {
    const job = await withMongoTransaction(this.connection, (session) =>
      this.createJob(
        {
          kind: 'reconcile',
          operationId: 'API-OPS-RECONCILE',
          scope: input.scope,
          repair: input.repair,
          idempotencyKey: input.idempotencyKey,
          batchKey: batchHash({
            workspaceId: context.workspaceId,
            operationId: 'API-OPS-RECONCILE',
            scope: input.scope,
            repair: input.repair,
          }),
        },
        context,
        session,
      ),
    );
    await this.enqueue(job, 'knowledge-cleanup', context);
    return jobResponse(job, 'API-OPS-RECONCILE');
  }

  async replayOutbox(
    input: { eventId: string; version: number; idempotencyKey: string },
    context: TenantContext,
  ): Promise<{ id: string; status: 'accepted'; jobId: string }> {
    const job = await withMongoTransaction(this.connection, async (session) => {
      const event = await this.outbox
        .findOne({
          workspaceId: requireWorkspaceId(context),
          _id: objectIdOf(input.eventId, context, 'eventId'),
          deletedAt: null,
        })
        .session(session)
        .lean();
      if (!event) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND');
      if (event.version !== input.version || !['failed', 'dead_letter'].includes(event.status)) {
        throw tenantError(context, 'KNOWLEDGE_CONFLICT', {
          version: input.version,
          actualVersion: event.version,
          status: event.status,
        });
      }
      const updated = await this.outbox.updateOne(
        {
          workspaceId: event.workspaceId,
          _id: event._id,
          version: input.version,
          status: { $in: ['failed', 'dead_letter'] },
          deletedAt: null,
        },
        {
          $set: {
            status: 'pending',
            availableAt: new Date(),
            error: null,
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
        { session },
      );
      if (updated.modifiedCount !== 1) throw tenantError(context, 'KNOWLEDGE_CONFLICT');
      return this.createJob(
        {
          kind: 'outbox',
          operationId: 'API-OPS-OUTBOX-REPLAY',
          scope: 'outbox',
          idempotencyKey: input.idempotencyKey,
          batchKey: batchHash({
            workspaceId: context.workspaceId,
            operationId: 'API-OPS-OUTBOX-REPLAY',
            scope: input.eventId,
          }),
          outboxEventId: input.eventId,
        },
        context,
        session,
      );
    });
    await this.enqueue(job, 'knowledge-outbox', context);
    return { id: input.eventId, status: 'accepted', jobId: String(job._id) };
  }

  async recoverStaleJobs(context: TenantContext): Promise<number> {
    return this.jobExecution.recoverExpiredLeases(context);
  }
}
