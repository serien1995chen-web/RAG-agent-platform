import { describe, expect, it } from 'vitest';
import {
  assertBatchVersions,
  assertCatalogMoveDepth,
  assertCatalogNoCycle,
  assertDirectoryDepth,
  canTransitionJob,
  permissionAllows,
  transitionSourcePermission,
} from '../../src/modules/knowledge/domain';
import { safeAuditDiff } from '../../src/shared/persistence/knowledge/audit';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_test',
  memberId: 'mem_test',
  requestId: 'req_test',
  traceId: 'trace_test',
  scopes: [],
};

describe('knowledge domain invariants', () => {
  it('permits only the frozen Job transitions', () => {
    expect(canTransitionJob('queued', 'leased')).toBe(true);
    expect(canTransitionJob('leased', 'running')).toBe(true);
    expect(canTransitionJob('running', 'succeeded')).toBe(true);
    expect(canTransitionJob('running', 'retry_wait')).toBe(true);
    expect(canTransitionJob('running', 'dead_letter')).toBe(false);
    expect(canTransitionJob('succeeded', 'running')).toBe(false);
    expect(canTransitionJob('cancelled', 'queued')).toBe(false);
  });

  it('applies the four-state Source permission machine', () => {
    expect(transitionSourcePermission('disabled', 'enable', context)).toBe('inherited');
    expect(transitionSourcePermission('inherited', 'detach', context)).toBe('independent');
    expect(transitionSourcePermission('independent', 'resume', context)).toBe('inherited');
    expect(transitionSourcePermission('inherited', 'disable', context)).toBe('disabled');
    expect(() => transitionSourcePermission('disabled', 'resume', context)).toThrowError(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({ code: 'KNOWLEDGE_CONFLICT' }),
        }),
      }),
    );
  });

  it('keeps permission ordering and directory depth bounded', () => {
    expect(permissionAllows('owner', 'manage')).toBe(true);
    expect(permissionAllows('read', 'write')).toBe(false);
    expect(() => assertDirectoryDepth(4, context)).not.toThrow();
    expect(() => assertDirectoryDepth(5, context)).toThrowError(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({ code: 'KNOWLEDGE_VALIDATION_FAILED' }),
        }),
      }),
    );
  });

  it('rejects catalog cycles and paths beyond depth four', () => {
    expect(() => assertCatalogNoCycle('a', null, [], context)).not.toThrow();
    expect(() => assertCatalogNoCycle('a', 'b', ['root', 'a', 'b'], context)).toThrowError(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({ code: 'KNOWLEDGE_CONFLICT' }),
        }),
      }),
    );
    expect(() => assertCatalogMoveDepth(4, context)).not.toThrow();
    expect(() => assertCatalogMoveDepth(5, context)).toThrowError(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({ code: 'KNOWLEDGE_CONFLICT' }),
        }),
      }),
    );
  });

  it('requires an exact positive version for every batch item and redacts audit data', () => {
    expect(assertBatchVersions(['a', 'b'], { a: 1, b: 2 }, context)).toEqual({ a: 1, b: 2 });
    expect(() => assertBatchVersions(['a'], { a: 1, b: 2 }, context)).toThrow();
    expect(
      safeAuditDiff({
        token: 'secret',
        promptVersion: 's8.image-caption.v1',
        nested: { authorization: 'Bearer x' },
      }),
    ).toEqual({
      token: '[REDACTED]',
      promptVersion: 's8.image-caption.v1',
      nested: { authorization: '[REDACTED]' },
    });
  });
});
