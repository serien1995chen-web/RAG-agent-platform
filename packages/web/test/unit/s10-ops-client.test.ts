import { describe, expect, it } from 'vitest';
import { apiKeysPath, auditPath, usagePath } from '../../src/client/s10-ops-client';
import { knowledgeQueryKeys } from '../../src/query/query-keys';
import { createSecretDraft, s10UiState } from '../../src/components/s10-ops-state';
import { KnowledgeRequestError } from '../../src/client/knowledge-client';

describe('S10 accessibility and client contracts', () => {
  it('keeps canonical paths and stable query keys', () => {
    expect(usagePath({ from: '2026-10-01', to: '2026-10-31', type: 'llm' })).toBe(
      '/v1/knowledge/usage?from=2026-10-01&to=2026-10-31&type=llm',
    );
    expect(auditPath({ action: 'api_key.create' })).toBe(
      '/v1/knowledge/audit-events?action=api_key.create',
    );
    expect(apiKeysPath({ limit: '200' })).toBe('/v1/knowledge/api-keys?limit=200');
    expect(knowledgeQueryKeys.usage.summary({ b: 2, a: 1 })).toEqual(
      knowledgeQueryKeys.usage.summary({ a: 1, b: 2 }),
    );
    expect(knowledgeQueryKeys.operations.cleanup('draft-a')).not.toEqual(
      knowledgeQueryKeys.operations.cleanup('draft-b'),
    );
  });

  it('maps permission, quota and dependency problems to distinct UI states', () => {
    const make = (code: string) =>
      new KnowledgeRequestError(400, {
        success: false,
        error: { code, message: code, retryable: false, details: {} },
        traceId: 'trace',
        requestId: 'request',
      });
    expect(s10UiState({ error: make('KNOWLEDGE_FORBIDDEN') })).toBe('forbidden');
    expect(s10UiState({ error: make('KNOWLEDGE_QUOTA_EXCEEDED') })).toBe('quota');
    expect(s10UiState({ error: make('KNOWLEDGE_DEPENDENCY_TIMEOUT') })).toBe('dependency');
    expect(createSecretDraft('kn_live_once')).toEqual({ secret: 'kn_live_once' });
    expect(createSecretDraft(null)).toEqual({ secret: null });
  });
});
