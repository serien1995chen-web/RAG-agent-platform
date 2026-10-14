import { describe, expect, it } from 'vitest';
import { collectionNameOf, getDeclaredIndexes } from '../../packages/service/src/index';
import {
  AuditAdapter,
  TrackAdapter,
  UsageAdapter,
  createAuditAdapter,
  createTrackAdapter,
  createUsageAdapter,
} from '../../packages/service/src/shared/observability';
import {
  OperationLogSchema,
  TrackSchema,
  UsageItemSchema,
  UsageSchema,
} from '../../packages/service/src/shared/persistence/schemas';

describe('ADR-017 Audit/Usage/Track 映射契约 (TEST-LOG-MAP-001)', () => {
  it('anchors the four canonical collections', () => {
    expect(collectionNameOf(OperationLogSchema)).toBe('operationLogs');
    expect(collectionNameOf(UsageSchema)).toBe('usages');
    expect(collectionNameOf(UsageItemSchema)).toBe('usage_items');
    expect(collectionNameOf(TrackSchema)).toBe('tracks');
  });

  it('keeps 360d TTL and dedup unique index declarations', () => {
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

  it('fixes the nullable extension field set of operationLogs', () => {
    const paths = OperationLogSchema.paths as unknown as Record<
      string,
      { options?: { default?: unknown } }
    >;
    const nullable = Object.keys(paths)
      .filter((name) => paths[name]?.options?.default === null)
      .sort();
    expect(nullable).toEqual(
      [
        'afterHash',
        'beforeHash',
        'operation',
        'params',
        'requestId',
        'resourceId',
        'resourceType',
        'result',
      ].sort(),
    );
  });

  it('exposes stable adapter factories and method surfaces', () => {
    expect(typeof createAuditAdapter).toBe('function');
    expect(typeof createUsageAdapter).toBe('function');
    expect(typeof createTrackAdapter).toBe('function');
    expect(typeof AuditAdapter.prototype.append).toBe('function');
    expect(typeof UsageAdapter.prototype.createUsage).toBe('function');
    expect(typeof UsageAdapter.prototype.pushUsageItems).toBe('function');
    expect(typeof UsageAdapter.prototype.listUsageItems).toBe('function');
    expect(typeof UsageAdapter.prototype.compareUsageCounts).toBe('function');
    expect(typeof TrackAdapter.prototype.record).toBe('function');
  });
});
