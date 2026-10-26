import { describe, expect, it } from 'vitest';
import { KnowledgeRequestError } from '../../src/client/knowledge-client';
import {
  batchResultRole,
  catalogGovernanceState,
  exportStatusTone,
  hasBlockingReference,
  shouldResetMoveIdempotencyKey,
} from '../../src/components/catalog-governance-state';
import { messages } from '../../src/i18n/messages';
import { knowledgeQueryKeys } from '../../src/query/query-keys';

function requestError(status: number, code: string) {
  return new KnowledgeRequestError(status, {
    success: false,
    error: {
      code: code as never,
      message: 'safe problem',
      retryable: false,
      details: {},
    },
    traceId: 'trace-a',
    requestId: 'request-a',
  });
}

describe('S3 catalog governance UI contract', () => {
  it('provides localized move, partial, export and reference states', () => {
    for (const key of [
      'governance.moveTarget',
      'governance.batchPartial',
      'governance.exportSpace',
      'governance.downloadExport',
      'governance.references',
      'governance.noReferences',
    ] as const) {
      expect(messages['zh-CN'][key]).toBeTruthy();
      expect(messages.en[key]).toBeTruthy();
    }
  });

  it('scopes reference queries by Space', () => {
    expect(knowledgeQueryKeys.spaces.references('space-a')).not.toEqual(
      knowledgeQueryKeys.spaces.references('space-b'),
    );
  });

  it('maps partial, conflict, forbidden, reference and network states', () => {
    expect(catalogGovernanceState(requestError(207, 'KNOWLEDGE_PARTIAL_SUCCESS'))).toBe('partial');
    expect(catalogGovernanceState(requestError(409, 'KNOWLEDGE_CONFLICT'))).toBe('conflict');
    expect(catalogGovernanceState(requestError(403, 'KNOWLEDGE_FORBIDDEN'))).toBe('forbidden');
    expect(catalogGovernanceState(requestError(409, 'KNOWLEDGE_REFERENCE_CONFLICT'))).toBe(
      'reference_blocked',
    );
    expect(catalogGovernanceState(new Error('offline'))).toBe('network');
  });

  it('resets move idempotency only for client errors and target changes', () => {
    expect(shouldResetMoveIdempotencyKey(requestError(409, 'KNOWLEDGE_CONFLICT'))).toBe(true);
    expect(shouldResetMoveIdempotencyKey(requestError(403, 'KNOWLEDGE_FORBIDDEN'))).toBe(true);
    expect(shouldResetMoveIdempotencyKey(requestError(500, 'KNOWLEDGE_INTERNAL_ERROR'))).toBe(
      false,
    );
    expect(shouldResetMoveIdempotencyKey(new Error('offline'))).toBe(false);
  });

  it('exposes batch, reference and export presentation states', () => {
    expect(batchResultRole({ failed: 1 })).toBe('alert');
    expect(batchResultRole({ failed: 0 })).toBe('status');
    expect(hasBlockingReference([{ status: 'stale' }, { status: 'active' }])).toBe(true);
    expect(hasBlockingReference([{ status: 'removed' }])).toBe(false);
    expect(exportStatusTone('queued')).toBe('warning');
    expect(exportStatusTone('running')).toBe('warning');
    expect(exportStatusTone('succeeded')).toBe('success');
    expect(exportStatusTone('failed')).toBe('danger');
  });
});
