import { ApiErrorException, createApiError } from '@kb/contracts';
import type { IdempotencyStore } from '@kb/dal';
import { createHash } from 'node:crypto';
import type { AuditPort, DatasetEvent, DatasetEventPort } from '../../../ports/capabilities';
import type { RequestContext } from '../../../ports/types';

/** 设计 7.7 / 附录 D：同步事件白名单固定五类（白名单变更必须走 ADR）。 */
export const EVENT_WHITELIST: readonly string[] = [
  'dataset.created',
  'dataset.updated',
  'dataset.deleted',
  'permission.changed',
  'delete.completed',
];

const DEFAULT_EVENT_TIMEOUT_MS = 2000;

export interface DatasetEventAdapterDeps {
  dispatch: (event: DatasetEvent, context: RequestContext) => Promise<{ accepted: boolean } | null>;
  idempotency: IdempotencyStore;
  audit?: AuditPort;
  eventPublishTimeoutMs?: number;
}

function eventHash(event: DatasetEvent): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        operation: event.operation,
        resourceVersion: event.resourceVersion,
        idempotencyKey: event.idempotencyKey,
      }),
    )
    .digest('hex');
}

/**
 * 设计 7.7：DatasetEventPort 适配器。
 * 同步阻塞（默认 2s）、五类白名单、eventId 幂等、剥离 payload、失败写补偿；
 * 事件失败不得让核心操作返回成功。
 */
export class DatasetEventAdapter implements DatasetEventPort {
  constructor(private readonly deps: DatasetEventAdapterDeps) {}

  private async bestEffortAudit(
    operation: string,
    event: DatasetEvent,
    context: RequestContext,
  ): Promise<void> {
    try {
      await this.deps.audit?.append(
        {
          eventId: `${operation}:${event.eventId}`,
          teamId: event.teamId,
          actorTmbId: context.tenant.tmbId,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          operation,
          requestId: context.requestId,
          payload: { eventId: event.eventId, operation: event.operation },
        },
        context,
      );
    } catch {
      // best-effort：审计失败不得掩盖原错误。
    }
  }

  async publish(event: DatasetEvent, context: RequestContext): Promise<{ accepted: boolean }> {
    if (!EVENT_WHITELIST.includes(event.operation)) {
      await this.bestEffortAudit('dataset.event.skipped', event, context);
      return { accepted: false };
    }

    const scope = `kb:dataset-event:${event.teamId}:${event.eventId}`;
    const begun = await this.deps.idempotency.begin(scope, eventHash(event));
    if (begun.kind === 'replay') return { accepted: true };
    if (begun.kind === 'conflict') {
      throw new ApiErrorException(
        createApiError({
          code: 501022,
          requestId: context.requestId,
          params: { extension: 'dataset.event', event: event.operation },
        }),
      );
    }

    const sanitized: DatasetEvent = {
      eventId: event.eventId,
      teamId: event.teamId,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      operation: event.operation,
      resourceVersion: event.resourceVersion,
      idempotencyKey: event.idempotencyKey,
    };
    const timeoutMs = this.deps.eventPublishTimeoutMs ?? DEFAULT_EVENT_TIMEOUT_MS;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dispatched: { accepted: boolean } | null;
    try {
      dispatched = await Promise.race([
        this.deps.dispatch(sanitized, context),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error('dataset_event_timeout'));
          }, timeoutMs);
        }),
      ]);
    } catch {
      if (timer !== undefined) clearTimeout(timer);
      if (timedOut) {
        await this.bestEffortAudit('dataset.event.timeout', event, context);
        throw new ApiErrorException(
          createApiError({
            code: 501021,
            requestId: context.requestId,
            params: { extension: 'dataset.event', timeoutMs },
          }),
        );
      }
      try {
        await this.deps.audit?.append(
          {
            eventId: `dataset.event.compensation:${event.eventId}`,
            teamId: event.teamId,
            actorTmbId: context.tenant.tmbId,
            resourceType: event.resourceType,
            resourceId: event.resourceId,
            operation: 'dataset.event.compensation',
            requestId: context.requestId,
            payload: { eventId: event.eventId, operation: event.operation, retryable: true },
          },
          context,
        );
      } catch {
        // best-effort
      }
      throw new ApiErrorException(
        createApiError({
          code: 501022,
          requestId: context.requestId,
          params: { extension: 'dataset.event', event: event.operation },
        }),
      );
    }
    if (timer !== undefined) clearTimeout(timer);

    if (dispatched === null) {
      throw new ApiErrorException(
        createApiError({
          code: 501020,
          requestId: context.requestId,
          params: { extension: 'dataset.event' },
        }),
      );
    }

    await this.deps.idempotency.complete(scope, { accepted: true });
    await this.bestEffortAudit('dataset.event.published', event, context);
    return { accepted: true };
  }
}

export function createDatasetEventAdapter(deps: DatasetEventAdapterDeps): DatasetEventAdapter {
  return new DatasetEventAdapter(deps);
}
