import { ApiErrorException, createApiError } from '../../packages/contracts/src/index';
import { describe, expect, it } from 'vitest';
import type { ObjectStorePort } from '../../packages/service/src/ports/capabilities';
import type { RequestContext } from '../../packages/service/src/ports/types';
import {
  S3TtlService,
  type S3TtlRecordView,
  type S3TtlStore,
} from '../../packages/service/src/modules/delete/application/s3-ttl.service';

const context: RequestContext = {
  requestId: 'req-ttl-fault',
  tenant: { teamId: 'team-a', tmbId: 'tmb-a', authType: 'internal', isRoot: false },
  permission: { canRead: true, canWrite: false, canManage: false, isOwner: false },
};

const fixedNow = new Date('2026-10-14T12:00:00.000Z');
const pastExpire = new Date(fixedNow.getTime() - 3_600_000);

interface FakeRecord {
  id: string;
  teamId: string;
  bucketName: string;
  objectKey: string;
  expireAt: Date;
  state: 'pending' | 'deleting' | 'failed';
  attempt: number;
  nextAttemptAt: Date;
  operationId: string;
  resourceRef: { resourceType: string; resourceId: string; version: number };
}

class FakeTtlStore implements S3TtlStore {
  readonly records = new Map<string, FakeRecord>();
  readonly formalRefs = new Set<string>();

  add(record: Partial<FakeRecord> & { id: string; objectKey: string }): void {
    this.records.set(record.id, {
      id: record.id,
      teamId: record.teamId ?? 'team-a',
      bucketName: 'kb-local',
      objectKey: record.objectKey,
      expireAt: record.expireAt ?? pastExpire,
      state: record.state ?? 'pending',
      attempt: record.attempt ?? 0,
      nextAttemptAt: record.nextAttemptAt ?? new Date(fixedNow.getTime() - 3_600_000),
      operationId: record.operationId ?? `op-${record.id}`,
      resourceRef: { resourceType: 'object', resourceId: record.objectKey, version: 0 },
    });
  }

  update(id: string, patch: Partial<FakeRecord>): void {
    const record = this.records.get(id);
    if (record) Object.assign(record, patch);
  }

  async claimBatch(input: { now: Date; limit: number }): Promise<S3TtlRecordView[]> {
    const threshold = new Date(input.now.getTime() - 5 * 60 * 1000);
    const claimed: S3TtlRecordView[] = [];
    for (const record of this.records.values()) {
      if (claimed.length >= input.limit) break;
      if (record.state === 'deleting') continue;
      if (record.attempt >= 10) continue;
      if (record.expireAt.getTime() > threshold.getTime()) continue;
      if (record.nextAttemptAt.getTime() > input.now.getTime()) continue;
      record.state = 'deleting';
      claimed.push({ ...record, resourceRef: { ...record.resourceRef } });
    }
    return claimed;
  }

  async markFailed(input: {
    id: string;
    teamId: string;
    attempt: number;
    nextAttemptAt: Date;
  }): Promise<boolean> {
    const record = this.records.get(input.id);
    if (!record || record.teamId !== input.teamId) return false;
    record.state = 'failed';
    record.attempt = input.attempt;
    record.nextAttemptAt = input.nextAttemptAt;
    return true;
  }

  async deleteRecord(input: { id: string; teamId: string }): Promise<boolean> {
    const record = this.records.get(input.id);
    if (!record || record.teamId !== input.teamId) return false;
    this.records.delete(input.id);
    return true;
  }

  async backfill(): Promise<void> {
    return undefined;
  }

  async hasFormalReference(input: { objectKey: string }): Promise<boolean> {
    return this.formalRefs.has(input.objectKey);
  }

  async hasTtlRecord(): Promise<boolean> {
    return false;
  }

  async resolveDatasetTeamId(): Promise<string | null> {
    return 'team-a';
  }
}

interface ObjectStoreCalls {
  aborts: string[];
  deletes: string[];
}

function objectStore(
  calls: ObjectStoreCalls,
  options: { abortError?: Error; deleteError?: Error } = {},
): ObjectStorePort {
  return {
    async abort(input: { ref: { key: string } }): Promise<{ aborted: boolean }> {
      if (options.abortError) throw options.abortError;
      calls.aborts.push(input.ref.key);
      return { aborted: true };
    },
    async delete(input: { ref: { key: string } }): Promise<{ deleted: boolean }> {
      if (options.deleteError) throw options.deleteError;
      calls.deletes.push(input.ref.key);
      return { deleted: true };
    },
  } as unknown as ObjectStorePort;
}

const bucketUnavailable = new ApiErrorException(
  createApiError({
    code: 501016,
    requestId: 'object-store',
    params: { store: 's3', operation: 'delete' },
  }),
);

function serviceOf(options: {
  store: FakeTtlStore;
  calls: ObjectStoreCalls;
  abortError?: Error;
  deleteError?: Error;
  now?: () => Date;
}): S3TtlService {
  return new S3TtlService({
    repository: options.store,
    objectStore: objectStore(options.calls, {
      ...(options.abortError !== undefined ? { abortError: options.abortError } : {}),
      ...(options.deleteError !== undefined ? { deleteError: options.deleteError } : {}),
    }),
    clock: options.now ?? (() => fixedNow),
  });
}

describe('FI: S3 TTL 故障批次（设计 10.9.1 / AB §4.3）', () => {
  it('bucket 不可用（501016）保留记录且等待下一轮', async () => {
    const store = new FakeTtlStore();
    store.add({ id: 'ttl-1', objectKey: 'temp/team-a/1.txt' });
    const calls: ObjectStoreCalls = { aborts: [], deletes: [] };
    const service = serviceOf({ store, calls, deleteError: bucketUnavailable });
    const stats = await service.sweepOnce(context);
    expect(stats.failed).toBe(1);
    const record = store.records.get('ttl-1');
    expect(record?.state).toBe('failed');
    expect(record?.attempt).toBe(0);
    expect(record?.nextAttemptAt.getTime()).toBe(fixedNow.getTime());
    expect(await store.claimBatch({ now: fixedNow, limit: 10 })).toHaveLength(1);
  });

  it('abort 失败不进删除步骤且保留记录', async () => {
    const store = new FakeTtlStore();
    store.add({ id: 'ttl-2', objectKey: 'temp/team-a/2.txt' });
    const calls: ObjectStoreCalls = { aborts: [], deletes: [] };
    const service = serviceOf({ store, calls, abortError: new Error('abort-failed') });
    const stats = await service.sweepOnce(context);
    expect(stats.failed).toBe(1);
    expect(calls.deletes).toHaveLength(0);
    const record = store.records.get('ttl-2');
    expect(record?.state).toBe('failed');
    expect(record?.attempt).toBe(1);
  });

  it('删除连续失败按指数退避且不超 10 次', async () => {
    const store = new FakeTtlStore();
    store.add({ id: 'ttl-3', objectKey: 'temp/team-a/3.txt' });
    const calls: ObjectStoreCalls = { aborts: [], deletes: [] };
    let now = fixedNow;
    const service = serviceOf({
      store,
      calls,
      deleteError: new Error('delete-failed'),
      now: () => now,
    });
    const expectedBackoffs = [60_000, 120_000, 240_000];
    for (const [index, expectedBackoff] of expectedBackoffs.entries()) {
      const stats = await service.sweepOnce(context);
      expect(stats.failed).toBe(1);
      const record = store.records.get('ttl-3');
      expect(record?.attempt).toBe(index + 1);
      expect(record?.nextAttemptAt.getTime()).toBe(now.getTime() + expectedBackoff);
      now = new Date(now.getTime() + 3_600_000);
    }
    store.update('ttl-3', {
      attempt: 9,
      state: 'pending',
      nextAttemptAt: new Date(now.getTime() - 60_000),
    });
    await service.sweepOnce(context);
    expect(store.records.get('ttl-3')?.attempt).toBe(10);
    expect(store.records.get('ttl-3')?.state).toBe('failed');
  });

  it('超限失败进入对账可见终态：attempt>=10 不再自动领取', async () => {
    const store = new FakeTtlStore();
    store.add({ id: 'ttl-4', objectKey: 'temp/team-a/4.txt', attempt: 10, state: 'failed' });
    const service = serviceOf({
      store,
      calls: { aborts: [], deletes: [] },
      deleteError: new Error('should-not-run'),
    });
    const stats = await service.sweepOnce(context);
    expect(stats.scanned).toBe(0);
    const record = store.records.get('ttl-4');
    expect(record?.state).toBe('failed');
    expect(record?.attempt).toBe(10);
  });

  it('promote 与正式引用对象在任何故障注入下都不被删除', async () => {
    const store = new FakeTtlStore();
    store.add({ id: 'ttl-5', objectKey: 'temp/team-a/5.txt' });
    store.formalRefs.add('temp/team-a/5.txt');
    const calls: ObjectStoreCalls = { aborts: [], deletes: [] };
    const service = serviceOf({ store, calls, deleteError: bucketUnavailable });
    const stats = await service.sweepOnce(context);
    expect(stats.deleted).toBe(1);
    expect(calls.aborts).toHaveLength(0);
    expect(calls.deletes).toHaveLength(0);
    expect(store.records.has('ttl-5')).toBe(false);
  });
});
