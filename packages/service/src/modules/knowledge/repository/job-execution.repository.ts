import { createHash, randomUUID } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';
import type { ClientSession, Connection, Model, Types } from 'mongoose';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type {
  KnowledgeJobDoc,
  KnowledgeJobStepDoc,
  KnowledgeOutboxEventDoc,
} from '../../../shared/persistence/schemas/knowledge-job.schemas';
import type { KnowledgeSourceDoc } from '../../../shared/persistence/schemas/knowledge-catalog.schemas';
import type { KnowledgeConnectorDoc } from '../../../shared/persistence/schemas/knowledge-connector.schemas';
import { createKnowledgeOutboxEvent } from '../../../shared/persistence/knowledge/outbox';
import { withMongoTransaction } from '../../../shared/persistence/with-mongo-transaction';
import {
  requireWorkspaceId,
  tenantError,
  type TenantContext,
} from '../../../shared/persistence/knowledge/tenant';
import { assertJobTransition, type JobState } from '../domain/job-state';
import { assertConnectorTransition } from '../domain/connector-state';

type Plain<T> = T & { _id: Types.ObjectId; version: number; createdAt: Date; updatedAt: Date };
type JobKind = KnowledgeJobDoc['kind'];

const TERMINAL_STATES: readonly JobState[] = ['succeeded', 'cancelled', 'failed', 'dead_letter'];
const JOB_QUEUE = {
  import: 'knowledge-import',
  parse: 'knowledge-parse',
  segment: 'knowledge-segment',
  qa: 'knowledge-qa',
  ocr: 'knowledge-ocr',
  caption: 'knowledge-caption',
  embed: 'knowledge-embed',
  index: 'knowledge-index',
  fulltext: 'knowledge-index',
  rebuild: 'knowledge-rebuild',
  sync: 'knowledge-sync',
  delete: 'knowledge-delete',
  cleanup: 'knowledge-cleanup',
  outbox: 'knowledge-outbox',
} as const;

export type PublicJobKind = 'parse' | 'segment' | 'qa' | 'embed' | 'index' | 'fulltext' | 'rebuild';

export interface CreateJobInput {
  kind: PublicJobKind;
  resourceType: 'space' | 'source' | 'segment';
  resourceId: string;
  inputSnapshot: Record<string, unknown>;
  priority?: number;
  idempotencyKey: string;
  knowledgeSpaceId: string;
}

export interface CreateChildJobInput extends CreateJobInput {
  rootJobId: string;
  parentJobId: string;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function jobDto(document: Plain<KnowledgeJobDoc>, steps: Plain<KnowledgeJobStepDoc>[] = []) {
  return {
    jobId: String(document._id),
    workspaceId: document.workspaceId,
    knowledgeSpaceId: String(document.knowledgeSpaceId),
    kind: document.kind,
    resourceType: document.resourceType,
    resourceId: document.resourceId,
    inputSnapshot: document.inputSnapshot,
    status: document.status,
    priority: document.priority,
    attempts: document.attempts,
    maxAttempts: document.maxAttempts,
    attemptEpoch: document.attemptEpoch,
    leaseOwner: document.leaseOwner,
    leaseExpiresAt: document.leaseExpiresAt?.toISOString() ?? null,
    heartbeatAt: document.heartbeatAt?.toISOString() ?? null,
    availableAt: document.availableAt.toISOString(),
    cancelRequestedAt: document.cancelRequestedAt?.toISOString() ?? null,
    pausedAt: document.pausedAt?.toISOString() ?? null,
    progress: document.progress,
    steps: steps.map((step) => ({
      stepKey: step.stepKey,
      status: step.status,
      attempts: step.attempts,
      externalEvidence: step.externalEvidence,
      compensationState: step.compensationState,
      error: step.error,
    })),
    error: document.error,
    result: document.result,
    version: document.version,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
}

function conflict(context: TenantContext, details: Record<string, unknown>) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_CONFLICT',
    requestId: context.requestId,
    traceId: context.traceId,
    details,
  });
}

function queueOf(kind: JobKind) {
  return JOB_QUEUE[kind as keyof typeof JOB_QUEUE];
}

export class KnowledgeJobExecutionRepository {
  private readonly jobs: Model<KnowledgeJobDoc>;
  private readonly steps: Model<KnowledgeJobStepDoc>;
  private readonly outbox: Model<KnowledgeOutboxEventDoc>;
  private readonly sources: Model<KnowledgeSourceDoc>;
  private readonly connectors: Model<KnowledgeConnectorDoc>;

  constructor(private readonly connection: Connection) {
    const models = registerKnowledgeModels(connection);
    this.jobs = models.KnowledgeJob;
    this.steps = models.KnowledgeJobStep;
    this.outbox = models.KnowledgeOutboxEvent;
    this.sources = models.KnowledgeSource;
    this.connectors = models.KnowledgeConnector;
  }

  private async createWithSession(
    input: CreateJobInput | CreateChildJobInput,
    context: TenantContext,
    session?: ClientSession,
  ) {
    const workspaceId = requireWorkspaceId(context);
    const requestHash = hash({
      kind: input.kind,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      inputSnapshot: input.inputSnapshot,
    });
    const existing = await this.jobs
      .findOne({ workspaceId, idempotencyKey: input.idempotencyKey, deletedAt: null })
      .session(session ?? null)
      .lean<Plain<KnowledgeJobDoc>>();
    if (existing) {
      if (existing.inputSnapshot.requestHash !== requestHash) {
        throw conflict(context, {
          reason: 'idempotency_body_mismatch',
          jobId: String(existing._id),
        });
      }
      return jobDto(existing);
    }
    const now = new Date();
    const [created] = await this.jobs.create(
      [
        {
          workspaceId,
          knowledgeSpaceId: input.knowledgeSpaceId,
          version: 1,
          deletedAt: null,
          createdByMemberId: context.memberId,
          updatedByMemberId: context.memberId,
          kind: input.kind,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          status: 'queued',
          priority: input.priority ?? 5,
          idempotencyKey: input.idempotencyKey,
          inputSnapshot: {
            ...input.inputSnapshot,
            requestHash,
            ...((input as CreateChildJobInput).rootJobId
              ? { rootJobId: (input as CreateChildJobInput).rootJobId }
              : {}),
            ...((input as CreateChildJobInput).parentJobId
              ? { parentJobId: (input as CreateChildJobInput).parentJobId }
              : {}),
          },
          progress: { stage: 'queued', completed: 0, total: 1, percent: 0 },
          attempts: 0,
          maxAttempts: input.kind === 'qa' ? 3 : 3,
          attemptEpoch: 0,
          fencingToken: 'unassigned',
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          availableAt: now,
          cancelRequestedAt: null,
          pausedAt: null,
          error: null,
          result: null,
          expiresAt: new Date(now.getTime() + 180 * 86_400_000),
        },
      ],
      { session, ordered: true },
    );
    if (!created) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_INTERNAL_ERROR',
        requestId: context.requestId,
        traceId: context.traceId,
        details: { reason: 'job_create_failed' },
      });
    }
    await createKnowledgeOutboxEvent(
      this.connection,
      {
        workspaceId,
        knowledgeSpaceId: input.knowledgeSpaceId,
        eventType: `${input.kind}.job.queued`,
        aggregateType: 'job',
        aggregateId: String(created._id),
        queue: queueOf(input.kind),
        payload: { jobId: String(created._id) },
      },
      context,
      session!,
    );
    return jobDto(created.toObject() as unknown as Plain<KnowledgeJobDoc>);
  }

  create(input: CreateJobInput, context: TenantContext) {
    return withMongoTransaction(this.connection, (session) =>
      this.createWithSession(input, context, session),
    );
  }

  createSourceRebuild(
    input: CreateJobInput & { resourceType: 'source'; sourceVersion: number },
    context: TenantContext,
  ) {
    return withMongoTransaction(this.connection, async (session) => {
      const source = await this.sources
        .findOne({
          _id: input.resourceId,
          workspaceId: requireWorkspaceId(context),
          sourceVersion: input.sourceVersion,
          deletedAt: null,
        })
        .session(session);
      if (!source)
        throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { sourceId: input.resourceId });
      if (!['ready', 'partial'].includes(source.processingStatus)) {
        throw conflict(context, {
          reason: 'source_not_ready_for_rebuild',
          status: source.processingStatus,
        });
      }
      const updated = await this.sources.findOneAndUpdate(
        {
          _id: source._id,
          workspaceId: source.workspaceId,
          version: source.version,
          sourceVersion: input.sourceVersion,
          processingStatus: source.processingStatus,
          deletedAt: null,
        },
        {
          $set: { processingStatus: 'rebuilding', updatedByMemberId: context.memberId },
          $inc: { version: 1 },
        },
        { new: true, session },
      );
      if (!updated)
        throw conflict(context, { reason: 'source_rebuild_cas', sourceId: input.resourceId });
      return this.createWithSession(input, context, session);
    });
  }

  createInSession(input: CreateJobInput, context: TenantContext, session: ClientSession) {
    return this.createWithSession(input, context, session);
  }

  createChild(input: CreateChildJobInput, context: TenantContext, session?: ClientSession) {
    return session
      ? this.createWithSession(input, context, session)
      : withMongoTransaction(this.connection, (transaction) =>
          this.createWithSession(input, context, transaction),
        );
  }

  async getRaw(jobId: string, context: TenantContext) {
    const document = await this.jobs
      .findOne({
        _id: jobId,
        workspaceId: requireWorkspaceId(context),
        deletedAt: null,
      })
      .lean<Plain<KnowledgeJobDoc>>();
    if (!document) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { jobId });
    return document;
  }

  async claimById(
    input: { jobId: string; kinds: readonly KnowledgeJobDoc['kind'][]; workerId: string },
    context: TenantContext,
  ) {
    const now = new Date();
    const job = await this.jobs.findOneAndUpdate(
      {
        _id: input.jobId,
        workspaceId: requireWorkspaceId(context),
        deletedAt: null,
        status: 'queued',
        availableAt: { $lte: now },
        kind: { $in: input.kinds },
      },
      {
        $set: {
          status: 'leased',
          leaseOwner: input.workerId,
          leaseExpiresAt: new Date(now.getTime() + 300_000),
          heartbeatAt: now,
          fencingToken: randomUUID(),
          updatedByMemberId: context.memberId,
        },
        $inc: { version: 1, attempts: 1, attemptEpoch: 1 },
      },
      { new: true },
    );
    return job ? jobDto(job.toObject() as unknown as Plain<KnowledgeJobDoc>) : null;
  }

  async start(
    jobId: string,
    expectedVersion: number,
    attemptEpoch: number,
    fencingToken: string,
    workerId: string,
    context: TenantContext,
  ) {
    const updated = await this.jobs.findOneAndUpdate(
      {
        _id: jobId,
        workspaceId: requireWorkspaceId(context),
        version: expectedVersion,
        status: 'leased',
        leaseOwner: workerId,
        attemptEpoch,
        fencingToken,
        leaseExpiresAt: { $gt: new Date() },
        deletedAt: null,
      },
      {
        $set: {
          status: 'running',
          progress: { stage: 'running', completed: 0, total: 1, percent: 0 },
          updatedByMemberId: context.memberId,
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    if (!updated) throw conflict(context, { reason: 'lease_lost', jobId });
    return jobDto(updated.toObject() as unknown as Plain<KnowledgeJobDoc>);
  }

  async heartbeat(
    jobId: string,
    expectedVersion: number,
    attemptEpoch: number,
    fencingToken: string,
    workerId: string,
    context: TenantContext,
  ) {
    const now = new Date();
    const updated = await this.jobs.findOneAndUpdate(
      {
        _id: jobId,
        workspaceId: requireWorkspaceId(context),
        version: expectedVersion,
        status: { $in: ['leased', 'running'] },
        leaseOwner: workerId,
        attemptEpoch,
        fencingToken,
        deletedAt: null,
      },
      {
        $set: { heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + 300_000) },
        $inc: { version: 1 },
      },
      { new: true },
    );
    if (!updated) throw conflict(context, { reason: 'lease_lost', jobId });
    return jobDto(updated.toObject() as unknown as Plain<KnowledgeJobDoc>);
  }

  async commit(
    jobId: string,
    expectedVersion: number,
    attemptEpoch: number,
    fencingToken: string,
    workerId: string,
    result: Record<string, unknown>,
    context: TenantContext,
  ) {
    const current = await this.jobs
      .findOne({
        _id: jobId,
        workspaceId: requireWorkspaceId(context),
        version: expectedVersion,
        status: 'running',
        leaseOwner: workerId,
        attemptEpoch,
        fencingToken,
        leaseExpiresAt: { $gt: new Date() },
        deletedAt: null,
      })
      .lean<Plain<KnowledgeJobDoc>>();
    if (!current) throw conflict(context, { reason: 'stale_fencing_token', jobId });
    const priorResult = (current.result ?? {}) as Record<string, unknown>;
    const mergedResult = {
      ...priorResult,
      ...result,
      ...(Array.isArray(priorResult.replayHistory)
        ? { replayHistory: priorResult.replayHistory }
        : {}),
    };
    const updated = await this.jobs.findOneAndUpdate(
      {
        _id: jobId,
        workspaceId: requireWorkspaceId(context),
        version: current.version,
        status: 'running',
        leaseOwner: workerId,
        attemptEpoch,
        fencingToken,
        leaseExpiresAt: { $gt: new Date() },
        deletedAt: null,
      },
      {
        $set: {
          status: 'succeeded',
          result: mergedResult,
          progress: { stage: 'succeeded', completed: 1, total: 1, percent: 100 },
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedByMemberId: context.memberId,
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    if (!updated) throw conflict(context, { reason: 'stale_fencing_token', jobId });
    return jobDto(updated.toObject() as unknown as Plain<KnowledgeJobDoc>);
  }

  async fail(
    jobId: string,
    expectedVersion: number,
    attemptEpoch: number,
    fencingToken: string,
    workerId: string,
    retryable: boolean,
    errorCode: string,
    context: TenantContext,
  ) {
    const current = await this.jobs.findOne({
      _id: jobId,
      workspaceId: requireWorkspaceId(context),
      version: expectedVersion,
      status: 'running',
      leaseOwner: workerId,
      attemptEpoch,
      fencingToken,
      deletedAt: null,
    });
    if (!current) throw conflict(context, { reason: 'stale_fencing_token', jobId });
    const exhausted = current.attempts >= current.maxAttempts;
    const next: JobState = retryable && !exhausted ? 'retry_wait' : 'failed';
    assertJobTransition(current.status, next, context);
    const updated = await this.jobs.findOneAndUpdate(
      { _id: current._id, workspaceId: current.workspaceId, version: current.version },
      {
        $set: {
          status: next,
          error: { code: errorCode, retryable },
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
    if (!updated) throw conflict(context, { reason: 'job_fail_cas', jobId });
    if (!exhausted) {
      return jobDto(updated.toObject() as unknown as Plain<KnowledgeJobDoc>);
    }
    const dead = await this.jobs.findOneAndUpdate(
      {
        _id: updated._id,
        workspaceId: updated.workspaceId,
        version: updated.version,
        status: 'failed',
      },
      {
        $set: { status: 'dead_letter', updatedByMemberId: context.memberId },
        $inc: { version: 1 },
      },
      { new: true },
    );
    if (!dead) throw conflict(context, { reason: 'job_dead_letter_cas', jobId });
    return jobDto(dead.toObject() as unknown as Plain<KnowledgeJobDoc>);
  }

  async releaseWaitingForChildren(
    jobId: string,
    childJobIds: string[],
    context: TenantContext,
    resultPatch: Record<string, unknown> = {},
  ) {
    const current = await this.jobs
      .findOne({
        _id: jobId,
        workspaceId: requireWorkspaceId(context),
        status: { $in: ['leased', 'running'] },
        deletedAt: null,
      })
      .lean<Plain<KnowledgeJobDoc>>();
    if (!current) throw conflict(context, { reason: 'parent_wait_cas', jobId });
    const priorResult = (current.result ?? {}) as Record<string, unknown>;
    const updated = await this.jobs.findOneAndUpdate(
      {
        _id: jobId,
        workspaceId: requireWorkspaceId(context),
        version: current.version,
        status: { $in: ['leased', 'running'] },
        deletedAt: null,
      },
      {
        $set: {
          leaseOwner: null,
          leaseExpiresAt: null,
          progress: {
            stage: 'waiting_children',
            completed: 0,
            total: childJobIds.length,
            percent: 0,
          },
          result: { ...priorResult, ...resultPatch, childJobIds },
          updatedByMemberId: context.memberId,
        },
        $inc: { version: 1 },
      },
      { new: true },
    );
    if (!updated) throw conflict(context, { reason: 'parent_wait_cas', jobId });
    return jobDto(updated.toObject() as unknown as Plain<KnowledgeJobDoc>);
  }

  async children(rootJobId: string, context: TenantContext) {
    return this.jobs
      .find({
        workspaceId: requireWorkspaceId(context),
        'inputSnapshot.rootJobId': rootJobId,
        deletedAt: null,
      })
      .lean<Plain<KnowledgeJobDoc>[]>();
  }

  async aggregateRoot(rootJobId: string, context: TenantContext) {
    const nodes = [
      await this.getRaw(rootJobId, context),
      ...(await this.children(rootJobId, context)),
    ];
    const root = nodes.find((node) => String(node._id) === rootJobId);
    if (!root) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { jobId: rootJobId });
    const byId = new Map(nodes.map((node) => [String(node._id), node]));
    const childrenByParent = new Map<string, Plain<KnowledgeJobDoc>[]>();
    for (const node of nodes) {
      const parentJobId = String(node.inputSnapshot.parentJobId ?? '');
      if (!parentJobId) continue;
      const children = childrenByParent.get(parentJobId) ?? [];
      children.push(node);
      childrenByParent.set(parentJobId, children);
    }
    const descendantsOf = (jobId: string): Plain<KnowledgeJobDoc>[] => {
      const descendants: Plain<KnowledgeJobDoc>[] = [];
      const pending = [...(childrenByParent.get(jobId) ?? [])];
      while (pending.length > 0) {
        const node = pending.shift()!;
        descendants.push(node);
        pending.push(...(childrenByParent.get(String(node._id)) ?? []));
      }
      return descendants;
    };
    const finalStatuses = new Map<string, JobState>();
    const errorCodeOf = (jobId: string, fallback: string): string => {
      const subtree = [byId.get(jobId)!, ...descendantsOf(jobId)].filter(Boolean);
      const failed = subtree.find(
        (candidate) =>
          (candidate.status === 'failed' || candidate.status === 'dead_letter') &&
          typeof candidate.error?.code === 'string',
      );
      return (failed?.error?.code as string | undefined) ?? fallback;
    };
    const finalize = async (
      node: Plain<KnowledgeJobDoc>,
      visiting: ReadonlySet<string> = new Set(),
    ): Promise<JobState | null> => {
      const jobId = String(node._id);
      if (visiting.has(jobId)) {
        throw conflict(context, { reason: 'job_tree_cycle', jobId });
      }
      const nextVisiting = new Set(visiting).add(jobId);
      const directChildren = childrenByParent.get(jobId) ?? [];
      const childStatuses: JobState[] = [];
      for (const child of directChildren) {
        const status = await finalize(child, nextVisiting);
        if (!status) return null;
        childStatuses.push(status);
      }
      if (childStatuses.some((status) => !TERMINAL_STATES.includes(status))) return null;
      if (TERMINAL_STATES.includes(node.status)) {
        const childStatus: JobState | undefined = childStatuses.includes('dead_letter')
          ? 'dead_letter'
          : childStatuses.includes('cancelled')
            ? 'cancelled'
            : childStatuses.includes('failed')
              ? 'failed'
              : undefined;
        const effectiveStatus = childStatus ?? node.status;
        finalStatuses.set(jobId, effectiveStatus);
        return effectiveStatus;
      }
      if (node.progress?.stage !== 'waiting_children') return null;

      const failed = childStatuses.filter((status) => status === 'failed').length;
      const dead = childStatuses.filter((status) => status === 'dead_letter').length;
      const cancelled = childStatuses.filter((status) => status === 'cancelled').length;
      const nextStatus: JobState = dead
        ? 'dead_letter'
        : cancelled
          ? 'cancelled'
          : failed
            ? 'failed'
            : 'succeeded';
      const firstStatus: JobState =
        node.status === 'running' && nextStatus === 'dead_letter'
          ? 'failed'
          : node.status === 'running' && nextStatus === 'cancelled'
            ? 'cancelling'
            : nextStatus;
      assertJobTransition(node.status, firstStatus, context);

      const subtree = [node, ...descendantsOf(jobId)];
      const sources = subtree
        .filter((candidate) => candidate.kind === 'parse')
        .map((candidate) => {
          const candidateId = String(candidate._id);
          const status = finalStatuses.get(candidateId) ?? candidate.status;
          return {
            sourceId: candidate.resourceId,
            sourceVersion: Number(candidate.inputSnapshot.sourceVersion ?? 1),
            status,
            childJobIds: (childrenByParent.get(candidateId) ?? []).map((child) =>
              String(child._id),
            ),
            errorCode:
              (candidate.error?.code as string | undefined) ??
              (status === 'failed' || status === 'dead_letter'
                ? errorCodeOf(candidateId, 'KNOWLEDGE_JOB_FAILED')
                : null),
          };
        });
      const priorResult = (node.result ?? {}) as Record<string, unknown>;
      const aggregateErrorCode =
        nextStatus === 'failed' || nextStatus === 'dead_letter'
          ? errorCodeOf(jobId, 'KNOWLEDGE_JOB_FAILED')
          : null;
      const result = {
        ...priorResult,
        childJobIds: subtree
          .filter((candidate) => String(candidate._id) !== jobId)
          .map((candidate) => String(candidate._id)),
        sources,
        partial: failed > 0 || dead > 0,
        completedAt: new Date().toISOString(),
      };
      const updated = await this.jobs.findOneAndUpdate(
        { _id: node._id, workspaceId: node.workspaceId, version: node.version },
        {
          $set: {
            status: firstStatus,
            leaseOwner: null,
            leaseExpiresAt: null,
            progress: {
              stage: firstStatus,
              completed: subtree.length,
              total: subtree.length,
              percent: 100,
            },
            result,
            error:
              nextStatus === 'failed' || nextStatus === 'dead_letter'
                ? { code: aggregateErrorCode, retryable: false }
                : null,
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
        { new: true },
      );
      if (!updated) {
        const latest = await this.getRaw(jobId, context);
        if (TERMINAL_STATES.includes(latest.status)) {
          Object.assign(node, latest);
          return latest.status;
        }
        throw conflict(context, { reason: 'root_aggregate_cas', jobId });
      }
      if (firstStatus !== nextStatus) {
        const terminal = await this.jobs.findOneAndUpdate(
          {
            _id: updated._id,
            workspaceId: updated.workspaceId,
            version: updated.version,
            status: firstStatus,
          },
          {
            $set: {
              status: nextStatus,
              progress: {
                stage: nextStatus,
                completed: subtree.length,
                total: subtree.length,
                percent: 100,
              },
              updatedByMemberId: context.memberId,
            },
            $inc: { version: 1 },
          },
          { new: true },
        );
        if (!terminal) throw conflict(context, { reason: 'root_terminal_cas', jobId });
        Object.assign(node, terminal.toObject());
        finalStatuses.set(jobId, nextStatus);
        return nextStatus;
      }
      Object.assign(node, updated.toObject());
      finalStatuses.set(jobId, nextStatus);
      return nextStatus;
    };

    const status = await finalize(byId.get(rootJobId)!);
    if (!status) return null;
    const latestRoot = byId.get(rootJobId)!;
    return jobDto(latestRoot);
  }

  async setStep(
    input: {
      jobId: string;
      stepKey: string;
      status: KnowledgeJobStepDoc['status'];
      idempotencyKey: string;
      evidence?: Record<string, unknown> | null;
      error?: Record<string, unknown> | null;
      compensationState?: KnowledgeJobStepDoc['compensationState'];
    },
    context: TenantContext,
  ) {
    const workspaceId = requireWorkspaceId(context);
    const now = new Date();
    const updated = await this.steps
      .findOneAndUpdate(
        {
          workspaceId,
          jobId: input.jobId,
          stepKey: input.stepKey,
          deletedAt: null,
        },
        {
          $setOnInsert: {
            workspaceId,
            knowledgeSpaceId: (await this.getRaw(input.jobId, context)).knowledgeSpaceId,
            deletedAt: null,
            createdByMemberId: context.memberId,
            jobId: input.jobId,
            stepKey: input.stepKey,
            expiresAt: new Date(now.getTime() + 180 * 86_400_000),
          },
          $set: {
            status: input.status,
            idempotencyKey: input.idempotencyKey,
            externalEvidence: input.evidence ?? null,
            error: input.error ?? null,
            compensationState: input.compensationState ?? 'none',
            updatedByMemberId: context.memberId,
          },
          $inc: { attempts: 1, version: 1 },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      )
      .lean<Plain<KnowledgeJobStepDoc>>();
    if (!updated) throw conflict(context, { reason: 'job_step_upsert_failed', jobId: input.jobId });
    return updated;
  }

  async control(
    action: 'retry' | 'cancel' | 'pause' | 'resume' | 'replay',
    jobId: string,
    expectedVersion: number,
    context: TenantContext,
  ) {
    return withMongoTransaction(this.connection, async (session) => {
      const root = await this.jobs
        .findOne({
          _id: jobId,
          workspaceId: requireWorkspaceId(context),
          version: expectedVersion,
          deletedAt: null,
        })
        .session(session);
      if (!root) throw conflict(context, { reason: 'version_conflict', jobId });
      const rootId = String(root.inputSnapshot.rootJobId ?? root._id);
      const tree = await this.jobs
        .find({
          workspaceId: root.workspaceId,
          deletedAt: null,
          $or: [{ _id: rootId }, { 'inputSnapshot.rootJobId': rootId }],
        })
        .session(session);
      const allowed: Record<typeof action, readonly JobState[]> = {
        retry: ['failed', 'dead_letter'],
        cancel: ['queued', 'leased', 'running', 'paused', 'retry_wait'],
        pause: ['queued', 'running'],
        resume: ['paused'],
        replay: ['dead_letter'],
      };
      const now = new Date();
      if (
        (action === 'retry' || action === 'replay') &&
        root.kind === 'sync' &&
        root.resourceType === 'connector'
      ) {
        const connector = await this.connectors
          .findOne({
            _id: root.resourceId,
            workspaceId: root.workspaceId,
            deletedAt: null,
          })
          .session(session);
        if (!connector) {
          throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', {
            connectorId: root.resourceId,
          });
        }
        if (connector.status === 'failed' || connector.status === 'active') {
          assertConnectorTransition(connector.status, 'syncing', context);
          const resumed = await this.connectors.findOneAndUpdate(
            {
              _id: connector._id,
              workspaceId: connector.workspaceId,
              version: connector.version,
              status: connector.status,
              deletedAt: null,
            },
            {
              $set: {
                status: 'syncing',
                lastAttemptAt: now,
                nextSyncAt: null,
                lastError: null,
                updatedByMemberId: context.memberId,
              },
              $inc: { version: 1 },
            },
            { new: true, session },
          );
          if (!resumed) {
            throw conflict(context, {
              reason: 'connector_retry_cas',
              connectorId: root.resourceId,
            });
          }
        } else if (connector.status !== 'syncing') {
          throw conflict(context, {
            reason: 'connector_retry_state',
            connectorId: root.resourceId,
            status: connector.status,
          });
        }
      }
      for (const node of tree) {
        const isTarget = String(node._id) === jobId;
        const isActiveDescendant = ['queued', 'leased', 'running', 'retry_wait', 'paused'].includes(
          node.status,
        );
        const isReplayableDescendant =
          (action === 'retry' || action === 'replay') &&
          ['failed', 'dead_letter'].includes(node.status);
        if (!isTarget && !isActiveDescendant && !isReplayableDescendant) continue;
        if (isTarget && !allowed[action].includes(node.status)) {
          throw conflict(context, { reason: 'invalid_job_state', jobId, status: node.status });
        }
        const next: JobState =
          action === 'pause'
            ? 'paused'
            : action === 'resume' || action === 'retry' || action === 'replay'
              ? 'queued'
              : node.status === 'queued'
                ? 'cancelled'
                : 'cancelling';
        if (node.status === next) continue;
        assertJobTransition(node.status, next, context);
        const update: Record<string, unknown> = {
          status: next,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedByMemberId: context.memberId,
          ...(next === 'paused' ? { pausedAt: now } : {}),
          ...(next === 'queued'
            ? {
                pausedAt: null,
                cancelRequestedAt: null,
                error: null,
                availableAt: now,
              }
            : {}),
          ...(next === 'cancelling' ? { cancelRequestedAt: now } : {}),
          ...(next === 'cancelled' ? { cancelRequestedAt: now } : {}),
        };
        const inc: Record<string, number> = { version: 1 };
        if (action === 'retry' || action === 'replay') {
          update.attemptEpoch = node.attemptEpoch + 1;
          update.attempts = 0;
          update.fencingToken = 'unassigned';
          update.result = {
            ...(node.result ?? {}),
            replayHistory: [
              ...(Array.isArray(node.result?.replayHistory) ? node.result.replayHistory : []),
              { attemptedAt: now.toISOString(), action, attemptEpoch: node.attemptEpoch },
            ],
          };
        }
        const updated = await this.jobs.findOneAndUpdate(
          { _id: node._id, workspaceId: node.workspaceId, version: node.version },
          { $set: update, $inc: inc },
          { new: true, session },
        );
        if (!updated) throw conflict(context, { reason: 'control_cas', jobId: String(node._id) });
        if (next === 'queued') {
          await createKnowledgeOutboxEvent(
            this.connection,
            {
              workspaceId: node.workspaceId,
              knowledgeSpaceId: String(node.knowledgeSpaceId),
              eventType: `${node.kind}.job.requeued`,
              aggregateType: 'job',
              aggregateId: String(node._id),
              queue: queueOf(node.kind),
              payload: { jobId: String(node._id) },
            },
            context,
            session,
          );
        }
      }
      const updatedRoot = await this.jobs
        .findOne({ _id: root._id, workspaceId: root.workspaceId, deletedAt: null })
        .session(session);
      if (!updatedRoot) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { jobId });
      return jobDto(updatedRoot.toObject() as unknown as Plain<KnowledgeJobDoc>);
    });
  }

  async hydrateOutbox(outboxEventId: string, context: TenantContext) {
    const event = await this.outbox
      .findOne({
        _id: outboxEventId,
        workspaceId: requireWorkspaceId(context),
        deletedAt: null,
      })
      .lean<Plain<KnowledgeOutboxEventDoc>>();
    if (!event) throw tenantError(context, 'KNOWLEDGE_NOT_FOUND', { outboxEventId });
    return event;
  }

  async recoverExpiredLeases(context: TenantContext): Promise<number> {
    const workspaceId = requireWorkspaceId(context);
    const now = new Date();
    const expired = await this.jobs
      .find({
        workspaceId,
        status: { $in: ['leased', 'running'] },
        leaseExpiresAt: { $lt: now },
        deletedAt: null,
      })
      .select({ _id: 1, version: 1 })
      .lean<Array<{ _id: Types.ObjectId; version: number }>>();
    let recovered = 0;
    for (const job of expired) {
      const updated = await this.jobs.findOneAndUpdate(
        {
          _id: job._id,
          workspaceId,
          version: job.version,
          status: { $in: ['leased', 'running'] },
          leaseExpiresAt: { $lt: now },
        },
        {
          $set: {
            status: 'retry_wait',
            leaseOwner: null,
            leaseExpiresAt: null,
            availableAt: now,
            error: { code: 'KNOWLEDGE_JOB_FAILED', retryable: true, reason: 'lease_expired' },
            updatedByMemberId: context.memberId,
          },
          $inc: { version: 1 },
        },
        { new: true },
      );
      if (updated) recovered += 1;
    }
    return recovered;
  }

  async requeueDueRetries(context: TenantContext, now = new Date()): Promise<number> {
    const workspaceId = requireWorkspaceId(context);
    const due = await this.jobs
      .find({
        workspaceId,
        status: 'retry_wait',
        availableAt: { $lte: now },
        deletedAt: null,
      })
      .select({ _id: 1, kind: 1, knowledgeSpaceId: 1, version: 1 })
      .sort({ availableAt: 1 })
      .lean<
        Array<{
          _id: Types.ObjectId;
          kind: KnowledgeJobDoc['kind'];
          knowledgeSpaceId: Types.ObjectId;
          version: number;
        }>
      >();
    let requeued = 0;
    for (const job of due) {
      const updated = await withMongoTransaction(this.connection, async (session) => {
        const document = await this.jobs.findOneAndUpdate(
          {
            _id: job._id,
            workspaceId,
            status: 'retry_wait',
            version: job.version,
            availableAt: { $lte: now },
          },
          {
            $set: {
              status: 'queued',
              availableAt: now,
              error: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedByMemberId: context.memberId,
            },
            $inc: { version: 1 },
          },
          { new: true, session },
        );
        if (!document) return false;
        await createKnowledgeOutboxEvent(
          this.connection,
          {
            workspaceId,
            knowledgeSpaceId: String(job.knowledgeSpaceId),
            eventType: `${job.kind}.job.retry`,
            aggregateType: 'job',
            aggregateId: String(job._id),
            queue: queueOf(job.kind),
            payload: { jobId: String(job._id) },
          },
          context,
          session,
        );
        return true;
      });
      if (updated) requeued += 1;
    }
    return requeued;
  }
}
