import type { Connection } from 'mongoose';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type { KnowledgeSourceDoc } from '../../../shared/persistence/schemas/knowledge-catalog.schemas';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { objectIdOf, requireWorkspaceId } from '../../../shared/persistence/knowledge/tenant';
import { KnowledgeJobRepository } from './job.repository';

function safeName(name: string): string {
  const base = name.replaceAll('\\', '/').split('/').pop() ?? 'source';
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return (safe || 'source').slice(0, 180);
}

export class KnowledgeArchiveRepository {
  private readonly jobs: KnowledgeJobRepository;
  private readonly jobModel;
  private readonly sourceModel;

  constructor(connection: Connection) {
    const models = registerKnowledgeModels(connection);
    this.jobs = new KnowledgeJobRepository(connection);
    this.jobModel = models.KnowledgeJob;
    this.sourceModel = models.KnowledgeSource;
  }

  private async enrichedJob(
    job: Record<string, unknown>,
    context: TenantContext,
  ): Promise<Record<string, unknown>> {
    const document = await this.jobModel
      .findOne({
        _id: String(job.jobId),
        workspaceId: context.workspaceId,
        deletedAt: null,
      })
      .lean();
    if (!document) return job;
    return {
      ...job,
      resourceType: document.resourceType,
      resourceId: document.resourceId,
      inputSnapshot: document.inputSnapshot,
      result: document.result,
      error: document.error,
      expiresAt:
        document.expiresAt instanceof Date ? document.expiresAt.toISOString() : document.expiresAt,
      version: document.version,
      attemptEpoch: document.attemptEpoch,
      fencingToken: document.fencingToken,
      leaseOwner: document.leaseOwner,
    };
  }

  async list(query: Parameters<KnowledgeJobRepository['list']>[0], context: TenantContext) {
    const page = await this.jobs.list(query, context);
    return {
      ...page,
      items: await Promise.all(page.items.map((job) => this.enrichedJob(job, context))),
    };
  }

  async get(jobId: string, context: TenantContext) {
    return this.enrichedJob(await this.jobs.get(jobId, context), context);
  }

  async findLatestSucceeded(kind: 'parse', resourceId: string, context: TenantContext) {
    requireWorkspaceId(context);
    const document = await this.jobModel
      .findOne({
        workspaceId: context.workspaceId,
        deletedAt: null,
        kind,
        resourceId,
        status: 'succeeded',
      })
      .sort({ updatedAt: -1 })
      .lean();
    if (!document) return null;
    return this.enrichedJob(await this.jobs.get(String(document._id), context), context);
  }

  async createExportJob(
    input: {
      spaceId: string;
      sourceIds: string[];
      idempotencyKey: string;
    },
    context: TenantContext,
  ): Promise<Record<string, unknown>> {
    requireWorkspaceId(context);
    const now = new Date();
    try {
      const document = await this.jobModel
        .findOneAndUpdate(
          {
            workspaceId: context.workspaceId,
            idempotencyKey: input.idempotencyKey,
            deletedAt: null,
          },
          {
            $setOnInsert: {
              workspaceId: context.workspaceId,
              knowledgeSpaceId: objectIdOf(input.spaceId, context, 'spaceId'),
              version: 1,
              deletedAt: null,
              createdByMemberId: context.memberId,
              updatedByMemberId: context.memberId,
              kind: 'export',
              resourceType: 'space',
              resourceId: input.spaceId,
              status: 'queued',
              priority: 0,
              idempotencyKey: input.idempotencyKey,
              inputSnapshot: {
                sourceIds: [...new Set(input.sourceIds)],
                format: 'zip',
              },
              progress: {
                stage: 'queued',
                completed: 0,
                total: input.sourceIds.length,
                percent: 0,
              },
              attempts: 0,
              maxAttempts: 3,
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
              expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
            },
          },
          { upsert: true, new: true },
        )
        .lean();
      return this.enrichedJob(await this.jobs.get(String(document?._id), context), context);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 11000
      ) {
        const existing = await this.jobModel
          .findOne({
            workspaceId: context.workspaceId,
            idempotencyKey: input.idempotencyKey,
            deletedAt: null,
          })
          .lean();
        if (existing) {
          return this.enrichedJob(await this.jobs.get(String(existing._id), context), context);
        }
      }
      throw error;
    }
  }

  transition(input: Parameters<KnowledgeJobRepository['transition']>[0], context: TenantContext) {
    return this.jobs.transition(input, context);
  }

  async queuedWorkspaces(): Promise<string[]> {
    const values = await this.jobModel.distinct('workspaceId', {
      kind: 'export',
      status: 'queued',
      deletedAt: null,
    });
    return values.filter((value): value is string => typeof value === 'string');
  }

  async claim(workerId: string, context: TenantContext) {
    const job = await this.jobs.claim({ kinds: ['export'], workerId }, context);
    return job ? this.enrichedJob(job, context) : null;
  }

  async start(input: Parameters<KnowledgeJobRepository['start']>[0], context: TenantContext) {
    return this.enrichedJob(await this.jobs.start(input, context), context);
  }

  async commit(input: Parameters<KnowledgeJobRepository['commit']>[0], context: TenantContext) {
    return this.enrichedJob(await this.jobs.commit(input, context), context);
  }

  async fail(input: Parameters<KnowledgeJobRepository['fail']>[0], context: TenantContext) {
    return this.enrichedJob(await this.jobs.fail(input, context), context);
  }

  async markFailureCode(jobId: string, code: string, context: TenantContext) {
    requireWorkspaceId(context);
    await this.jobModel.updateOne(
      {
        _id: objectIdOf(jobId, context, 'jobId'),
        workspaceId: context.workspaceId,
        deletedAt: null,
      },
      {
        $set: {
          'error.code': code,
          'error.retryable': false,
        },
      },
    );
    return this.enrichedJob(await this.jobs.get(jobId, context), context);
  }

  async sources(
    sourceIds: readonly string[],
    context: TenantContext,
  ): Promise<Array<KnowledgeSourceDoc & { _id: unknown; safeName: string }>> {
    const docs = await this.sourceModel
      .find({
        workspaceId: context.workspaceId,
        deletedAt: null,
        _id: { $in: sourceIds },
      })
      .lean();
    return (docs as unknown as Array<KnowledgeSourceDoc & { _id: unknown }>).map((doc) => ({
      ...doc,
      safeName: safeName(doc.name),
    }));
  }
}
