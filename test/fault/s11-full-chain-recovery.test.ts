import { describe, expect, it } from 'vitest';
import { normalizeRecovery } from '../../scripts/lib/recovery-summary.mjs';

const stableCounts = {
  KnowledgeJob: 4,
  KnowledgeSource: 2,
  KnowledgeUsageEvent: 7,
  KnowledgeAuditEvent: 9,
  KnowledgeOutboxEvent: 3,
};

function recovery(overrides = {}) {
  return normalizeRecovery({
    changeId: 'change-s11-full-chain',
    candidateSha: 'UNFROZEN',
    isolatedSource: 'kb_s11_source',
    isolatedRestore: 'kb_s11_restore_target',
    commands: [{ command: 'mongorestore', args: ['$KB_MONGO_URI'] }],
    beforeCounts: stableCounts,
    afterCounts: stableCounts,
    eventIds: ['event-1', 'event-2'],
    vectors: [{ vectorId: 'vector-1' }],
    objects: [{ active: true, referenced: true, objectKeyHash: 'object-1' }],
    health: { healthz: 200, readyz: 200 },
    blockers: [],
    ...overrides,
  });
}

describe('TEST-X-S11-FULL-CHAIN / TEST-X-S11-RECONCILE recovery', () => {
  it('requires health and readiness before a recovery PASS', () => {
    expect(recovery().status).toBe('PASS');
    expect(recovery({ health: { healthz: 200, readyz: 503 } })).toMatchObject({
      status: 'FAIL',
      health: { status: 'FAIL', healthz: 200, readyz: 503 },
    });
    expect(recovery({ health: { healthz: 503, readyz: 200 } }).status).toBe('FAIL');
  });

  it('rejects duplicate outbox/usage events, vectors and active orphans', () => {
    expect(recovery({ eventIds: ['event-1', 'event-1'] }).status).toBe('FAIL');
    expect(recovery({ vectors: [{ vectorId: 'vector-1' }, { vectorId: 'vector-1' }] }).status).toBe(
      'FAIL',
    );
    expect(
      recovery({ objects: [{ active: true, referenced: false, objectKeyHash: 'orphan' }] }).status,
    ).toBe('FAIL');
  });

  it('does not turn a blocked recovery prerequisite into PASS', () => {
    expect(
      recovery({
        blockers: [{ code: 'RECOVERY_MEDIA_BLOCKED', detail: 'backup media missing' }],
      }),
    ).toMatchObject({
      status: 'SCOPED_BLOCKED',
      blockers: [expect.objectContaining({ code: 'RECOVERY_MEDIA_BLOCKED' })],
    });
  });

  it('keeps recovery evidence free of connection strings and object keys', () => {
    const text = JSON.stringify(recovery());
    expect(text).not.toContain('mongodb://');
    expect(text).not.toContain('object-1');
  });
});
