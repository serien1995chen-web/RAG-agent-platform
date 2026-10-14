import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiErrorException, getDeclaredIndexes } from '../../src/index';
import type { AuditRecord } from '../../src/ports/capabilities';
import type { RequestContext } from '../../src/ports/types';
import {
  createAuditAdapter,
  createTrackAdapter,
  createUsageAdapter,
  type AuditAdapter,
  type TrackAdapter,
  type UsageAdapter,
} from '../../src/shared/observability';
import {
  OperationLogSchema,
  TrackSchema,
  UsageItemSchema,
  UsageSchema,
  type OperationLogDoc,
  type TrackDoc,
  type UsageDoc,
  type UsageItemDoc,
} from '../../src/shared/persistence/schemas';

const teamId = new mongoose.Types.ObjectId();
const otherTeamId = new mongoose.Types.ObjectId();
const tmbId = String(new mongoose.Types.ObjectId());
const context: RequestContext = {
  requestId: 'req-audit-usage',
  tenant: { teamId: String(teamId), tmbId, authType: 'token', isRoot: false },
  permission: { canRead: true, canWrite: true, canManage: true, isOwner: true },
};

let replSet: MongoMemoryReplSet;
let connection: mongoose.Connection;
let operations: mongoose.Model<OperationLogDoc>;
let usages: mongoose.Model<UsageDoc>;
let usageItems: mongoose.Model<UsageItemDoc>;
let tracks: mongoose.Model<TrackDoc>;
let audit: AuditAdapter;
let usage: UsageAdapter;
let disabledTrack: TrackAdapter;
let enabledTrack: TrackAdapter;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  connection = mongoose.createConnection(replSet.getUri('kb_audit_usage'));
  await connection.asPromise();
  operations = connection.model<OperationLogDoc>('OperationLog', OperationLogSchema);
  usages = connection.model<UsageDoc>('Usage', UsageSchema);
  usageItems = connection.model<UsageItemDoc>('UsageItem', UsageItemSchema);
  tracks = connection.model<TrackDoc>('Track', TrackSchema);
  await Promise.all([operations.init(), usages.init(), usageItems.init(), tracks.init()]);
  audit = createAuditAdapter({ connection });
  usage = createUsageAdapter({ connection });
  disabledTrack = createTrackAdapter({ connection, enabled: false });
  enabledTrack = createTrackAdapter({ connection, enabled: true });
}, 300_000);

beforeEach(async () => {
  await Promise.all([
    operations.deleteMany({}),
    usages.deleteMany({}),
    usageItems.deleteMany({}),
    tracks.deleteMany({}),
  ]);
});

afterAll(async () => {
  await connection.close();
  await replSet.stop();
});

async function expectApiError(promise: Promise<unknown>, code: number): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApiErrorException);
  expect((caught as ApiErrorException).error.code).toBe(code);
}

function auditRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    eventId: 'evt-1',
    teamId: String(teamId),
    actorTmbId: tmbId,
    resourceType: 'dataset',
    resourceId: '000000000000000000000001',
    operation: 'permission.changed',
    requestId: context.requestId,
    ...overrides,
  };
}

describe('Audit/Usage/Track adapters (P7-02 / TEST-OBS-AUDIT-001 / TEST-LOG-MAP-001)', () => {
  it('keeps audit append idempotent per eventId and rejects forged teamId', async () => {
    const first = await audit.append(auditRecord(), context);
    const second = await audit.append(auditRecord(), context);
    expect(second.auditId).toBe(first.auditId);
    expect(await operations.countDocuments({ teamId })).toBe(1);

    await expectApiError(
      audit.append(auditRecord({ teamId: String(otherTeamId) }), context),
      501070,
    );
  });

  it('wraps audit write failures as 501028 without touching business flow', async () => {
    const closed = mongoose.createConnection(replSet.getUri('kb_audit_closed'), {
      bufferCommands: false,
    });
    await closed.asPromise();
    const failing = createAuditAdapter({ connection: closed });
    await closed.close();

    await expectApiError(failing.append(auditRecord({ eventId: 'evt-closed' }), context), 501028);
  });

  it('dedups usage items by dedupKey and never blocks the caller', async () => {
    const created = await usage.createUsage(
      { tmbId, source: 'training', appName: 'kb-app', totalPoints: 12 },
      context,
    );
    expect(created.degraded).toBe(false);
    const usageId = String(created.usageId);

    const first = await usage.pushUsageItems(
      {
        usageId,
        items: [{ name: 'train-tokens', amount: 1, itemType: 'token', dedupKey: 'dedup-1' }],
      },
      context,
    );
    expect(first).toEqual({ inserted: 1, skipped: 0, degraded: false });

    const second = await usage.pushUsageItems(
      {
        usageId,
        items: [{ name: 'train-tokens', amount: 1, itemType: 'token', dedupKey: 'dedup-1' }],
      },
      context,
    );
    expect(second.skipped).toBeGreaterThanOrEqual(1);
    expect(second.degraded).toBe(false);
    expect(await usageItems.countDocuments({ teamId, usageId })).toBe(1);
  });

  it('declares 360d TTL and dedup unique indexes on the schema truth source', () => {
    const usageTtl = getDeclaredIndexes(UsageSchema).find(
      (entry) => entry.name === 'ds_usages_time_ttl_idx',
    );
    expect(usageTtl?.options?.expireAfterSeconds).toBe(31104000);

    const itemTtl = getDeclaredIndexes(UsageItemSchema).find(
      (entry) => entry.name === 'ds_usage_items_time_ttl_idx',
    );
    expect(itemTtl?.options?.expireAfterSeconds).toBe(31104000);

    const dedup = getDeclaredIndexes(UsageItemSchema).find(
      (entry) => entry.name === 'ds_usage_items_team_dedup_unique',
    );
    expect(dedup?.options?.unique).toBe(true);
    expect(dedup?.options?.partialFilterExpression).toEqual({ dedupKey: { $type: 'string' } });
  });

  it('falls back to legacy usages.list and prefers canonical items when present', async () => {
    const legacyDoc = await usages.create({
      teamId,
      tmbId: new mongoose.Types.ObjectId(tmbId),
      source: 'training',
      appName: 'legacy-app',
      totalPoints: 5,
      time: new Date(),
      list: [{ name: 'legacy-item', amount: 5 }],
    });
    const usageId = String(legacyDoc._id);

    const legacyRead = await usage.listUsageItems({ usageId }, context);
    expect(legacyRead.source).toBe('legacy');
    expect(legacyRead.items).toHaveLength(1);

    const pushed = await usage.pushUsageItems(
      {
        usageId,
        items: [{ name: 'canonical-item', amount: 5, itemType: 'token', dedupKey: 'dedup-legacy' }],
      },
      context,
    );
    expect(pushed).toEqual({ inserted: 1, skipped: 0, degraded: false });

    const canonicalRead = await usage.listUsageItems({ usageId }, context);
    expect(canonicalRead.source).toBe('canonical');
    expect(canonicalRead.items).toHaveLength(1);

    const compare = await usage.compareUsageCounts({ usageId }, context);
    expect(compare).toEqual({ canonical: 1, legacy: 1, equal: true });
  });

  it('gates tracks by SaaS flag and degrades without throwing', async () => {
    const skipped = await disabledTrack.record({ event: 'track-event' }, context);
    expect(skipped).toEqual({ stored: false, skipped: true, degraded: false });
    expect(await tracks.countDocuments({})).toBe(0);

    const stored = await enabledTrack.record({ event: 'track-event', data: { page: 1 } }, context);
    expect(stored).toEqual({ stored: true, skipped: false, degraded: false });
    expect(await tracks.countDocuments({ event: 'track-event' })).toBe(1);

    const closed = mongoose.createConnection(replSet.getUri('kb_tracks_closed'), {
      bufferCommands: false,
    });
    await closed.asPromise();
    const failing = createTrackAdapter({ connection: closed, enabled: true });
    await closed.close();

    const degraded = await failing.record({ event: 'track-event' }, context);
    expect(degraded).toEqual({ stored: false, skipped: false, degraded: true });
  });
});
