import { describe, expect, it, vi } from 'vitest';
import { ApiErrorException } from '../../packages/contracts/src/index';
import { MemoryIdempotencyStore } from '../../packages/dal/src/index';
import { DatasetApiService } from '../../packages/service/src/index';
import type {
  DatasetEvent,
  DatasetSummaryValue,
  KnowledgeBaseQueryRepository,
  RequestContext,
} from '../../packages/service/src/index';
import {
  createDatasetEventAdapter,
  type DatasetEventAdapterDeps,
} from '../../packages/service/src/modules/processing/adapter/dataset-event.adapter';
import { createDatasetNotificationAdapter } from '../../packages/service/src/modules/processing/adapter/dataset-notification.adapter';
import { createDefaultExtensionRegistry } from '../../projects/app/src/extensions/index';

const devIdentity = {
  teamId: '000000000000000000000001',
  tmbId: '000000000000000000000002',
};

const context: RequestContext = {
  requestId: 'req-extension-test',
  tenant: {
    teamId: devIdentity.teamId,
    tmbId: devIdentity.tmbId,
    authType: 'token',
    isRoot: false,
  },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

const datasetSummary: DatasetSummaryValue = {
  datasetId: '0000000000000000000000aa',
  teamId: devIdentity.teamId,
  name: 'demo',
  type: 'knowledge',
  parentId: null,
  vectorModel: 'bge-m3',
  indexVersion: 'bge-m3:1536:v1',
  inheritPermission: true,
  autoSync: false,
  deleteTime: null,
  version: 1,
  createTime: '2026-10-05T00:00:00.000Z',
  updateTime: '2026-10-05T00:00:00.000Z',
};

describe('non-Dataset extension points (9.1-9.4)', () => {
  it('enables the fixed dev identity only outside production', () => {
    const development = createDefaultExtensionRegistry({
      environment: 'development',
      devIdentity,
    });
    expect(development.isEnabled('identity')).toBe(true);
    expect(development.require<{ resolve: unknown }>('identity')).toBeDefined();

    const production = createDefaultExtensionRegistry({
      environment: 'production',
      devIdentity,
    });
    expect(production.isEnabled('identity')).toBe(false);
    expect(() => production.require('identity')).toThrow(ApiErrorException);
  });

  it('returns stable 501020 for agent/application/publish without guessing', () => {
    const registry = createDefaultExtensionRegistry({
      environment: 'development',
      devIdentity,
    });
    for (const id of ['agent', 'application', 'publish'] as const) {
      expect(registry.isEnabled(id)).toBe(false);
      let caught: unknown;
      try {
        registry.require(id);
      } catch (error) {
        caught = error;
      }
      const apiError = caught as ApiErrorException;
      expect(apiError.error.code).toBe(501020);
      expect(apiError.error.params.extension).toBe(id);
    }
  });

  it('keeps the Dataset core working when every extension is disabled (ACC-ARCH-004)', async () => {
    const repository: KnowledgeBaseQueryRepository & {
      create: (...args: never[]) => Promise<{ datasetId: string; version: number }>;
    } = {
      create: async () => ({ datasetId: datasetSummary.datasetId, version: 1 }),
      listByTeam: async () => ({ total: 1, list: [datasetSummary] }),
      findByDatasetId: async () => datasetSummary,
      countChildren: async () => 0,
    };
    const registry = createDefaultExtensionRegistry({
      environment: 'production',
      devIdentity: null,
    });
    expect(registry.isEnabled('identity')).toBe(false);
    expect(registry.isEnabled('agent')).toBe(false);

    const service = new DatasetApiService({ repository: repository as never });
    const listed = await service.listDatasets({ page: 1, limit: 20 }, context);
    expect(listed.total).toBe(1);
    expect(listed.list[0]?.name).toBe('demo');
    const detail = await service.getDatasetDetail(datasetSummary.datasetId, context);
    expect(detail.stats.collections).toBe(0);
  });
});

function eventOf(overrides: Partial<DatasetEvent> = {}): DatasetEvent {
  return {
    eventId: 'evt-1',
    teamId: devIdentity.teamId,
    resourceType: 'dataset',
    resourceId: datasetSummary.datasetId,
    operation: 'dataset.updated',
    resourceVersion: 1,
    idempotencyKey: 'idem-1',
    ...overrides,
  };
}

async function expectApiError(promise: Promise<unknown>, code: number): Promise<ApiErrorException> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApiErrorException);
  expect((caught as ApiErrorException).error.code).toBe(code);
  return caught as ApiErrorException;
}

function auditRecorder(): {
  audit: NonNullable<DatasetEventAdapterDeps['audit']>;
  operations: string[];
} {
  const operations: string[] = [];
  const audit = {
    append: async (record: { operation: string }) => {
      operations.push(record.operation);
      return { auditId: `audit-${operations.length}` };
    },
  };
  return { audit: audit as unknown as NonNullable<DatasetEventAdapterDeps['audit']>, operations };
}

const WHITELIST: readonly string[] = [
  'dataset.created',
  'dataset.updated',
  'dataset.deleted',
  'permission.changed',
  'delete.completed',
];

describe('P7-01 dataset event and notification adapters (TEST-EVENT-001)', () => {
  it('dispatches only the five whitelisted operations', async () => {
    const dispatched: string[] = [];
    const adapter = createDatasetEventAdapter({
      dispatch: async (event) => {
        dispatched.push(event.operation);
        return { accepted: true };
      },
      idempotency: new MemoryIdempotencyStore(),
    });
    for (const [index, operation] of WHITELIST.entries()) {
      const result = await adapter.publish(
        eventOf({ operation, eventId: `evt-wl-${index}` }),
        context,
      );
      expect(result).toEqual({ accepted: true });
    }
    expect(dispatched).toEqual([...WHITELIST]);

    const skipped = await adapter.publish(eventOf({ operation: 'dataset.unknown' }), context);
    expect(skipped).toEqual({ accepted: false });
    expect(dispatched).toHaveLength(WHITELIST.length);
  });

  it('blocks for 2000ms by default and fails with 501021 on timeout', async () => {
    vi.useFakeTimers();
    try {
      const { audit, operations } = auditRecorder();
      const adapter = createDatasetEventAdapter({
        dispatch: () => new Promise<never>(() => {}),
        idempotency: new MemoryIdempotencyStore(),
        audit,
      });
      const promise = adapter.publish(eventOf(), context);
      const assertion = expectApiError(promise, 501021);
      await vi.advanceTimersByTimeAsync(2000);
      const caught = await assertion;
      expect(caught.error.params.timeoutMs).toBe(2000);
      expect(operations).toContain('dataset.event.timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates by eventId and replays without dispatching twice', async () => {
    const dispatch = vi.fn(async () => ({ accepted: true }));
    const adapter = createDatasetEventAdapter({
      dispatch,
      idempotency: new MemoryIdempotencyStore(),
    });
    await adapter.publish(eventOf(), context);
    const replay = await adapter.publish(eventOf(), context);
    expect(replay).toEqual({ accepted: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('writes a compensation record and fails with 501022 when dispatch throws', async () => {
    const { audit, operations } = auditRecorder();
    const adapter = createDatasetEventAdapter({
      dispatch: async () => {
        throw new Error('dispatch down');
      },
      idempotency: new MemoryIdempotencyStore(),
      audit,
    });
    await expectApiError(adapter.publish(eventOf(), context), 501022);
    expect(operations).toContain('dataset.event.compensation');
  });

  it('fails with 501020 (extension=dataset.event) when dispatch returns null', async () => {
    const adapter = createDatasetEventAdapter({
      dispatch: async () => null,
      idempotency: new MemoryIdempotencyStore(),
    });
    const caught = await expectApiError(adapter.publish(eventOf(), context), 501020);
    expect(caught.error.params.extension).toBe('dataset.event');
  });

  it('delivers notifications best-effort without touching the event port', async () => {
    const notification = {
      notificationId: 'n-1',
      teamId: devIdentity.teamId,
      kind: 'permission.changed',
      payload: { channel: 'dataset', recipientRef: 'member-1' },
    };
    const okAdapter = createDatasetNotificationAdapter({
      notify: { send: async () => ({ delivered: true }) },
    });
    expect(await okAdapter.onDatasetChange(notification, context)).toEqual({ delivered: true });

    const failing = createDatasetNotificationAdapter({
      notify: {
        send: async () => {
          throw new Error('channel down');
        },
      },
    });
    expect(await failing.onFailure(notification, context)).toEqual({ delivered: false });

    const falseAdapter = createDatasetNotificationAdapter({
      notify: { send: async () => ({ delivered: false }) },
    });
    expect(await falseAdapter.onDatasetChange(notification, context)).toEqual({ delivered: false });
  });
});
