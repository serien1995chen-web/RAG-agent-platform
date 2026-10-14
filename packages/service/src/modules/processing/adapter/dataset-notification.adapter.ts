import type {
  DatasetNotificationPort,
  NotificationEvent,
  NotifyPort,
} from '../../../ports/capabilities';
import type { RequestContext } from '../../../ports/types';

/** 设计 9.4 / 7.7：通知通道适配（best-effort，不冒充 DatasetEventPort）。 */
export interface DatasetNotificationAdapterDeps {
  notify: NotifyPort;
}

export class DatasetNotificationAdapter implements DatasetNotificationPort {
  constructor(private readonly deps: DatasetNotificationAdapterDeps) {}

  private async deliver(
    event: NotificationEvent,
    context: RequestContext,
  ): Promise<{ delivered: boolean }> {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const channel = typeof payload.channel === 'string' ? payload.channel : 'dataset';
    const recipientRef =
      typeof payload.recipientRef === 'string' ? payload.recipientRef : event.notificationId;
    try {
      const result = await this.deps.notify.send(
        {
          channel,
          recipientRef,
          messageKey: `dataset.notification.${event.kind}`,
          params: payload,
        },
        context,
      );
      return { delivered: result.delivered === true };
    } catch {
      return { delivered: false };
    }
  }

  onDatasetChange(
    event: NotificationEvent,
    context: RequestContext,
  ): Promise<{ delivered: boolean }> {
    return this.deliver(event, context);
  }

  onFailure(event: NotificationEvent, context: RequestContext): Promise<{ delivered: boolean }> {
    return this.deliver(event, context);
  }
}

export function createDatasetNotificationAdapter(
  deps: DatasetNotificationAdapterDeps,
): DatasetNotificationAdapter {
  return new DatasetNotificationAdapter(deps);
}
