import { describe, expect, it } from 'vitest';
import {
  assertConnectorTransition,
  canTransitionConnector,
} from '../../src/modules/knowledge/domain/connector-state';
import { requestHashOf, stableJson } from '../../src/modules/knowledge/domain/import-submission';

describe('S4 ingestion domain', () => {
  it('produces stable request hashes independent of object key order', () => {
    expect(stableJson({ b: 2, a: 1 })).toBe(stableJson({ a: 1, b: 2 }));
    expect(requestHashOf({ b: 2, a: 1 })).toBe(requestHashOf({ a: 1, b: 2 }));
  });

  it('enforces connector state transitions without undocumented shortcuts', () => {
    expect(canTransitionConnector('active', 'syncing')).toBe(true);
    expect(canTransitionConnector('syncing', 'active')).toBe(true);
    expect(canTransitionConnector('failed', 'syncing')).toBe(true);
    expect(canTransitionConnector('active', 'deleted')).toBe(false);
    expect(() =>
      assertConnectorTransition('active', 'deleted', {
        requestId: 'req',
        traceId: 'trace',
      }),
    ).toThrow();
  });
});
