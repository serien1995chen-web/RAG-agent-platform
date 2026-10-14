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
import {
  INSTRUMENT_CLASSES,
  METRIC_DEFINITIONS,
  METRIC_NAMES,
  metricDropCount,
  recordMetric,
} from '../../packages/service/src/shared/observability/instruments';

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

describe('指标字典与统一记录入口 (P7-03 / 15.1-15.2)', () => {
  it('freezes the 43-metric dictionary and the 13-instrument class list', () => {
    expect(METRIC_DEFINITIONS).toHaveLength(43);
    expect(METRIC_NAMES).toEqual(METRIC_DEFINITIONS.map((entry) => entry.name));
    expect(new Set(METRIC_NAMES).size).toBe(43);
    expect(INSTRUMENT_CLASSES).toHaveLength(13);
    expect(new Set(INSTRUMENT_CLASSES).size).toBe(13);
    expect(METRIC_DEFINITIONS.every((entry) => !entry.allowedAttributes.includes('teamId'))).toBe(
      true,
    );
  });

  it('records whitelisted metrics through the entry without throwing', () => {
    const calls: Array<{ name: string; attributes: Record<string, string> }> = [];
    const port = {
      record: (name: string, _value: number, attributes: Record<string, string>) => {
        calls.push({ name, attributes });
      },
    };
    expect(
      recordMetric(port, 'dataset_http_requests_total', 1, { method: 'GET', route: '/x' }),
    ).toEqual({ recorded: true });
    expect(
      recordMetric(port, 'dataset_http_requests_total', 1, { route: '/x', leaked: 'y' }),
    ).toEqual({ recorded: true, dropped: 'attribute_not_allowed' });
    expect(calls[1]?.attributes).toEqual({ route: '/x' });
    expect(recordMetric(port, 'nope_metric', 1, {})).toEqual({
      recorded: false,
      dropped: 'unknown_metric',
    });

    const before = metricDropCount();
    const boom = {
      record: () => {
        throw new Error('metrics down');
      },
    };
    expect(recordMetric(boom, 'dataset_queue_depth', 1, { queue: 'q' })).toEqual({
      recorded: false,
    });
    expect(metricDropCount()).toBe(before + 1);
  });
});
