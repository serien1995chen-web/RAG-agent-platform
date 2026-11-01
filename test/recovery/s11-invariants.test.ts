import { describe, expect, it } from 'vitest';
import {
  assertNoActiveOrphans,
  assertNoDuplicateEventIds,
  assertNoDuplicateVectors,
  compareCounts,
  normalizeRecovery,
} from '../../scripts/lib/recovery-summary.mjs';

describe('TEST-X-BACKUP-RESTORE / TEST-X-S11-RECONCILE invariants', () => {
  it('requires exact before/after counts and a clean reconcile', () => {
    expect(
      compareCounts(
        { KnowledgeJob: 4, KnowledgeSource: 2, KnowledgeUsageEvent: 7 },
        { KnowledgeJob: 4, KnowledgeSource: 2, KnowledgeUsageEvent: 7 },
      ).status,
    ).toBe('PASS');
    expect(compareCounts({ KnowledgeJob: 4 }, { KnowledgeJob: 5 }).differences).toEqual([
      { name: 'KnowledgeJob', before: 4, after: 5 },
    ]);
  });

  it('detects duplicate event IDs, duplicate vectors and active orphan objects', () => {
    expect(assertNoDuplicateEventIds(['event-1', 'event-2']).status).toBe('PASS');
    expect(assertNoDuplicateEventIds(['event-1', 'event-1']).duplicates).toEqual(['event-1']);
    expect(
      assertNoDuplicateVectors([{ vectorId: 'vector-1' }, { vectorId: 'vector-1' }]).duplicates,
    ).toEqual(['vector-1']);
    expect(
      assertNoActiveOrphans([{ active: true, referenced: false, objectKeyHash: 'secret-key' }]),
    ).toMatchObject({ status: 'FAIL', orphanCount: 1 });
  });

  it('normalizes only evidence-safe fields and never returns a PASS on a failed invariant', () => {
    const summary = normalizeRecovery({
      changeId: 'change-s11',
      candidateSha: 'UNFROZEN',
      isolatedSource: 'kb_s11_source',
      isolatedRestore: 'kb_s11_restore_target',
      commands: [{ command: 'mongodump', args: ['$KB_MONGO_URI'] }],
      beforeCounts: { KnowledgeJob: 1 },
      afterCounts: { KnowledgeJob: 2 },
      eventIds: ['event-1'],
      vectors: [{ vectorId: 'vector-1' }],
      objects: [],
      health: { healthz: 200, readyz: 503 },
    });
    expect(summary.status).toBe('FAIL');
    expect(summary.counts.differences).toHaveLength(1);
    expect(JSON.stringify(summary)).not.toContain('mongodb://');
  });
});
