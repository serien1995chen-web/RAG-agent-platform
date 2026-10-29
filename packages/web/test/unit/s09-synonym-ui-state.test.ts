import { describe, expect, it } from 'vitest';
import type { KnowledgeProblem } from '@kb/contracts';
import {
  messageKeyOf,
  synonymUiState,
  validateSynonymFileDraft,
} from '../../src/components/s09-synonym-state';

const config = {
  knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
  fileName: 'synonyms.csv',
  sizeBytes: 128,
  activeFileVersion: 2,
  enabled: true,
  schemaVersion: 2 as const,
  status: 'active' as const,
  mappingCount: 2,
  termCount: 4,
  version: 3,
  updatedAt: '2026-10-28T12:00:00.000Z',
  lastError: null,
};

const invalidProblem: KnowledgeProblem = {
  success: false,
  error: {
    code: 'KNOWLEDGE_SYNONYM_INVALID',
    message: 'invalid',
    retryable: false,
    details: {
      diagnostics: [
        {
          rowNumber: 3,
          columnNumber: 2,
          code: 'DUPLICATE_TERM',
          messageKey: 'knowledge.synonym.invalid.duplicate_term',
          params: {},
        },
      ],
      totalDiagnostics: 1,
      truncated: false,
    },
  },
  traceId: 'trace-fixture',
  requestId: 'request-fixture',
};

describe('S9 synonym UI state', () => {
  it('TEST-X-FRONTEND-A11Y validates only extension and size on the client', () => {
    expect(validateSynonymFileDraft(null)).toEqual({
      valid: false,
      field: 'file',
      reason: 'required',
    });
    expect(validateSynonymFileDraft({ name: 'synonyms.txt', sizeBytes: 1 })).toMatchObject({
      valid: false,
      reason: 'extension',
    });
    expect(
      validateSynonymFileDraft({ name: 'synonyms.xlsx', sizeBytes: 10 * 1024 * 1024 }),
    ).toEqual({ valid: true });
    expect(
      validateSynonymFileDraft({ name: 'synonyms.xlsx', sizeBytes: 10 * 1024 * 1024 + 1 }),
    ).toMatchObject({ valid: false, reason: 'size' });
  });

  it('TEST-X-FRONTEND-A11Y maps empty, rebuilding, failed, disabled and ready states', () => {
    expect(synonymUiState({})).toEqual({ kind: 'empty' });
    expect(synonymUiState({ config: { ...config, status: 'rebuilding' } })).toMatchObject({
      kind: 'rebuilding',
    });
    expect(synonymUiState({ config: { ...config, status: 'failed' } })).toMatchObject({
      kind: 'failed',
    });
    expect(
      synonymUiState({ config: { ...config, status: 'disabled', enabled: false } }),
    ).toMatchObject({ kind: 'disabled' });
    expect(
      synonymUiState({
        config,
        mappings: [
          {
            logicalMappingId: '000000000000000000000001',
            fileVersion: 2,
            standardizedTerm: '退款',
            normalizedStandardizedTerm: '退款',
            synonymTerms: ['退货'],
            normalizedSynonymTerms: ['退货'],
            fingerprint: 'a'.repeat(64),
          },
        ],
      }),
    ).toMatchObject({ kind: 'ready' });
  });

  it('TEST-X-FRONTEND-A11Y preserves row diagnostics without exposing file text', () => {
    const state = synonymUiState({ problem: invalidProblem, config });
    expect(state).toMatchObject({
      kind: 'invalid_file',
      code: 'KNOWLEDGE_SYNONYM_INVALID',
      traceId: 'trace-fixture',
      diagnostics: [
        {
          rowNumber: 3,
          columnNumber: 2,
          messageKey: 'knowledge.synonym.invalid.duplicate_term',
        },
      ],
    });
    expect(JSON.stringify(state)).not.toContain('退款');
    expect(messageKeyOf(invalidProblem)).toBe('KNOWLEDGE_SYNONYM_INVALID');
  });
});
