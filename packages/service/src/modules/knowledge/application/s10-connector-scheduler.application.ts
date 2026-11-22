import { createHash } from 'node:crypto';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import type { ConnectorView, JobView } from './ingestion.ports';

export interface S10ConnectorScheduleClaim {
  scheduleId: string;
  connectorId: string;
  knowledgeSpaceId: string;
  dueAt: Date;
  attempt: number;
  leaseOwner: string;
}

export interface S10ConnectorScheduleRepositoryPort {
  listWorkspaceIds(): Promise<string[]>;
  reconcile(context: TenantContext, now: Date): Promise<{ inserted: number; removed: number }>;
  claimNext(
    context: TenantContext,
    workerId: string,
    now: Date,
  ): Promise<S10ConnectorScheduleClaim | null>;
  markDispatched(
    claim: S10ConnectorScheduleClaim,
    nextDueAt: Date,
    now: Date,
    context: TenantContext,
  ): Promise<void>;
  reschedule(
    claim: S10ConnectorScheduleClaim,
    nextDueAt: Date | null,
    context: TenantContext,
  ): Promise<void>;
  fail(
    claim: S10ConnectorScheduleClaim,
    reason: string,
    now: Date,
    context: TenantContext,
  ): Promise<void>;
}

export interface S10ConnectorSchedulerConnectorPort {
  get(connectorId: string, context: TenantContext): Promise<ConnectorView>;
  markSyncing(
    connectorId: string,
    command: {
      full: boolean;
      expectedCursorVersion?: number;
      requestHash: string;
      idempotencyKey: string;
    },
    context: TenantContext,
  ): Promise<{ connector: ConnectorView; job: JobView }>;
}

export interface S10ConnectorSchedulerRunResult {
  workspaces: number;
  inserted: number;
  removed: number;
  dispatched: number;
  skipped: number;
  failed: number;
}

function schedulerContext(workspaceId: string, workerId: string, at: Date): TenantContext {
  return {
    workspaceId,
    memberId: 'system:connector-scheduler',
    requestId: `scheduler:${workerId}:${at.getTime()}`,
    traceId: createHash('sha256')
      .update(`scheduler:${workspaceId}:${at.toISOString()}`)
      .digest('hex'),
    scopes: ['knowledge:admin'],
    isWorkspaceOwner: false,
  };
}

function scheduleIdentity(claim: S10ConnectorScheduleClaim, connector: ConnectorView): string {
  return [
    claim.connectorId,
    claim.dueAt.toISOString(),
    connector.version,
    connector.cursorVersion,
  ].join('|');
}

export class S10ConnectorSchedulerApplication {
  constructor(
    private readonly input: {
      schedules: S10ConnectorScheduleRepositoryPort;
      connectors: S10ConnectorSchedulerConnectorPort;
      now?: () => Date;
    },
  ) {}

  async runOnce(input: {
    workerId: string;
    now?: Date;
    maxDispatches?: number;
  }): Promise<S10ConnectorSchedulerRunResult> {
    const now = input.now ?? this.input.now?.() ?? new Date();
    const maxDispatches = Math.max(1, Math.min(500, input.maxDispatches ?? 100));
    const workspaceIds = await this.input.schedules.listWorkspaceIds();
    const result: S10ConnectorSchedulerRunResult = {
      workspaces: workspaceIds.length,
      inserted: 0,
      removed: 0,
      dispatched: 0,
      skipped: 0,
      failed: 0,
    };

    for (const workspaceId of workspaceIds) {
      const context = schedulerContext(workspaceId, input.workerId, now);
      const reconciled = await this.input.schedules.reconcile(context, now);
      result.inserted += reconciled.inserted;
      result.removed += reconciled.removed;

      while (result.dispatched + result.failed < maxDispatches) {
        const claim = await this.input.schedules.claimNext(context, input.workerId, now);
        if (!claim) break;
        let connector: ConnectorView;
        try {
          connector = await this.input.connectors.get(claim.connectorId, context);
        } catch {
          await this.input.schedules.reschedule(claim, null, context);
          result.removed += 1;
          continue;
        }
        if (
          !connector.syncEnabled ||
          connector.status !== 'active' ||
          connector.nextSyncAt === null
        ) {
          await this.input.schedules.reschedule(
            claim,
            connector.nextSyncAt ? new Date(connector.nextSyncAt) : null,
            context,
          );
          result.skipped += 1;
          continue;
        }

        try {
          const identity = scheduleIdentity(claim, connector);
          const digest = createHash('sha256').update(identity).digest('hex');
          await this.input.connectors.markSyncing(
            claim.connectorId,
            {
              full: false,
              requestHash: digest,
              idempotencyKey: `auto-${digest.slice(0, 40)}`,
            },
            context,
          );
          await this.input.schedules.markDispatched(
            claim,
            new Date(now.getTime() + connector.syncIntervalMinutes * 60_000),
            now,
            context,
          );
          result.dispatched += 1;
        } catch {
          await this.input.schedules.fail(claim, 'KNOWLEDGE_JOB_FAILED', now, context);
          result.failed += 1;
        }
      }
    }
    return result;
  }
}
