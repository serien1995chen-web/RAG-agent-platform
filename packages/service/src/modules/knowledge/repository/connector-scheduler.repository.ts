import { randomUUID } from 'node:crypto';
import { Types, type Connection, type Model } from 'mongoose';
import type {
  S10ConnectorScheduleClaim,
  S10ConnectorScheduleRepositoryPort,
} from '../application/s10-connector-scheduler.application';
import {
  requireWorkspaceId,
  type TenantContext,
} from '../../../shared/persistence/knowledge/tenant';
import { registerKnowledgeModels } from '../../../shared/persistence/schemas/knowledge-index';
import type {
  KnowledgeConnectorDoc,
  KnowledgeConnectorScheduleDoc,
} from '../../../shared/persistence/schemas/knowledge-connector.schemas';
import type { KnowledgeSpaceDoc } from '../../../shared/persistence/schemas/knowledge-catalog.schemas';

type Plain<T> = T & { _id: Types.ObjectId };

export class KnowledgeConnectorScheduleRepository implements S10ConnectorScheduleRepositoryPort {
  private readonly connectors: Model<KnowledgeConnectorDoc>;
  private readonly schedules: Model<KnowledgeConnectorScheduleDoc>;
  private readonly spaces: Model<KnowledgeSpaceDoc>;

  constructor(connection: Connection) {
    const models = registerKnowledgeModels(connection);
    this.connectors = models.KnowledgeConnector;
    this.schedules = models.KnowledgeConnectorSchedule;
    this.spaces = models.KnowledgeSpace as Model<KnowledgeSpaceDoc>;
  }

  async listWorkspaceIds(): Promise<string[]> {
    const [connectorIds, scheduleIds] = await Promise.all([
      this.connectors.distinct('workspaceId', { deletedAt: null }),
      this.schedules.distinct('workspaceId', { deletedAt: null }),
    ]);
    return [...new Set([...connectorIds, ...scheduleIds])]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .sort();
  }

  async reconcile(
    context: TenantContext,
    now: Date,
  ): Promise<{ inserted: number; removed: number }> {
    const workspaceId = requireWorkspaceId(context);
    const [connectors, schedules, spaces] = await Promise.all([
      this.connectors
        .find({ workspaceId, deletedAt: null })
        .select({
          _id: 1,
          knowledgeSpaceId: 1,
          syncEnabled: 1,
          status: 1,
          syncIntervalMinutes: 1,
          nextSyncAt: 1,
          version: 1,
          deletedAt: 1,
          workspaceId: 1,
          createdByMemberId: 1,
          updatedByMemberId: 1,
          createdAt: 1,
          updatedAt: 1,
        })
        .lean<Plain<KnowledgeConnectorDoc>[]>(),
      this.schedules
        .find({ workspaceId, deletedAt: null })
        .lean<Plain<KnowledgeConnectorScheduleDoc>[]>(),
      this.spaces
        .find({ workspaceId, deletedAt: null })
        .select({ _id: 1, autoSync: 1 })
        .lean<Array<Plain<KnowledgeSpaceDoc>>>(),
    ]);
    const autoSyncBySpace = new Map(
      spaces.map((space) => [String(space._id), space.autoSync !== false]),
    );
    const scheduleByConnector = new Map(
      schedules.map((schedule) => [String(schedule.connectorId), schedule]),
    );
    const eligibleConnectorIds = new Set<string>();
    let inserted = 0;
    let removed = 0;

    for (const connector of connectors) {
      const connectorId = String(connector._id);
      const eligible =
        autoSyncBySpace.get(String(connector.knowledgeSpaceId)) === true &&
        connector.syncEnabled &&
        connector.status === 'active' &&
        connector.nextSyncAt !== null;
      if (!eligible) continue;
      eligibleConnectorIds.add(connectorId);
      const existing = scheduleByConnector.get(connectorId);
      if (existing) {
        if (
          existing.status === 'claimed' &&
          existing.leaseExpiresAt !== null &&
          existing.leaseExpiresAt.getTime() > now.getTime()
        ) {
          continue;
        }
        await this.schedules.updateOne(
          { _id: existing._id, workspaceId, deletedAt: null },
          {
            $set: {
              knowledgeSpaceId: connector.knowledgeSpaceId,
              dueAt: connector.nextSyncAt,
              status: 'scheduled',
              leaseOwner: null,
              leaseExpiresAt: null,
              lastError: null,
              updatedByMemberId: context.memberId,
            },
          },
        );
      } else {
        try {
          await this.schedules.updateOne(
            { workspaceId, connectorId: connector._id, deletedAt: null },
            {
              $setOnInsert: {
                workspaceId,
                knowledgeSpaceId: connector.knowledgeSpaceId,
                connectorId: connector._id,
                version: 1,
                deletedAt: null,
                createdByMemberId: context.memberId,
                attempt: 0,
                lastDispatchedAt: null,
                lastError: null,
              },
              $set: {
                dueAt: connector.nextSyncAt,
                status: 'scheduled',
                leaseOwner: null,
                leaseExpiresAt: null,
                updatedByMemberId: context.memberId,
              },
            },
            { upsert: true },
          );
          inserted += 1;
        } catch (error) {
          if ((error as { code?: number }).code !== 11000) throw error;
        }
      }
    }

    for (const schedule of schedules) {
      if (eligibleConnectorIds.has(String(schedule.connectorId))) continue;
      await this.schedules.deleteOne({ _id: schedule._id, workspaceId });
      removed += 1;
    }
    return { inserted, removed };
  }

  async claimNext(
    context: TenantContext,
    workerId: string,
    now: Date,
  ): Promise<S10ConnectorScheduleClaim | null> {
    const workspaceId = requireWorkspaceId(context);
    const leaseOwner = `${workerId}:${randomUUID()}`;
    const claimed = await this.schedules
      .findOneAndUpdate(
        {
          workspaceId,
          deletedAt: null,
          dueAt: { $lte: now },
          $or: [{ status: 'scheduled' }, { status: 'claimed', leaseExpiresAt: { $lte: now } }],
        },
        {
          $set: {
            status: 'claimed',
            leaseOwner,
            leaseExpiresAt: new Date(now.getTime() + 120_000),
            lastError: null,
            updatedByMemberId: context.memberId,
          },
          $inc: { attempt: 1, version: 1 },
        },
        { new: true, sort: { dueAt: 1, _id: 1 } },
      )
      .lean<Plain<KnowledgeConnectorScheduleDoc>>();
    if (!claimed) return null;
    return {
      scheduleId: String(claimed._id),
      connectorId: String(claimed.connectorId),
      knowledgeSpaceId: String(claimed.knowledgeSpaceId),
      dueAt: claimed.dueAt,
      attempt: claimed.attempt,
      leaseOwner,
    };
  }

  private claimFilter(claim: S10ConnectorScheduleClaim, context: TenantContext) {
    return {
      _id: new Types.ObjectId(claim.scheduleId),
      workspaceId: requireWorkspaceId(context),
      connectorId: new Types.ObjectId(claim.connectorId),
      status: 'claimed',
      leaseOwner: claim.leaseOwner,
      deletedAt: null,
    };
  }

  async markDispatched(
    claim: S10ConnectorScheduleClaim,
    nextDueAt: Date,
    now: Date,
    context: TenantContext,
  ): Promise<void> {
    await this.schedules.updateOne(this.claimFilter(claim, context), {
      $set: {
        dueAt: nextDueAt,
        status: 'dispatched',
        leaseOwner: null,
        leaseExpiresAt: null,
        lastDispatchedAt: now,
        lastError: null,
        updatedByMemberId: context.memberId,
      },
    });
  }

  async reschedule(
    claim: S10ConnectorScheduleClaim,
    nextDueAt: Date | null,
    context: TenantContext,
  ): Promise<void> {
    const filter = this.claimFilter(claim, context);
    if (!nextDueAt) {
      await this.schedules.deleteOne(filter);
      return;
    }
    await this.schedules.updateOne(filter, {
      $set: {
        dueAt: nextDueAt,
        status: 'scheduled',
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        updatedByMemberId: context.memberId,
      },
    });
  }

  async fail(
    claim: S10ConnectorScheduleClaim,
    reason: string,
    now: Date,
    context: TenantContext,
  ): Promise<void> {
    await this.schedules.updateOne(this.claimFilter(claim, context), {
      $set: {
        dueAt: new Date(now.getTime() + 60_000),
        status: 'scheduled',
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: { code: reason, retryable: true },
        updatedByMemberId: context.memberId,
      },
    });
  }
}
