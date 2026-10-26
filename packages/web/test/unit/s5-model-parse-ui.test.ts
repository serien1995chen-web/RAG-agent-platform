import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canSaveBinding,
  groupModelsByType,
  mergeBindingDraft,
  providerVerificationLabel,
  safeConflictRetryState,
  stateFromProblem,
  toS5ProblemView,
  type S5ModelBindingView,
  type S5ModelView,
} from '../../src/components/s5-model-parse-state';
import {
  parseChunkingSettingsDraft,
  s5ExternalOcrConfigFormSchema,
  s5LiteParseConfigFormSchema,
} from '../../src/forms/s5-model-parse-form';

const models: S5ModelView[] = [
  {
    modelId: 'llm-b',
    displayName: 'LLM B',
    type: 'llm',
    capabilities: ['chat'],
    authorized: true,
  },
  {
    modelId: 'llm-a',
    displayName: 'LLM A',
    type: 'llm',
    capabilities: ['chat', 'structured-output'],
    authorized: true,
  },
  {
    modelId: 'embedding-1024',
    displayName: 'Embedding',
    type: 'embedding',
    capabilities: ['dimension:1024', 'text-embedding'],
    authorized: true,
  },
  {
    modelId: 'hidden',
    displayName: 'Hidden',
    type: 'llm',
    capabilities: ['chat'],
    authorized: false,
  },
];

function problem(status: number, code: string) {
  return {
    status,
    problem: {
      success: false,
      error: {
        code,
        message: 'backend text must not be displayed',
        retryable: false,
        details: { field: 'version', status },
      },
      traceId: 'trace-a',
      requestId: 'request-a',
    },
  };
}

describe('ACC-UI-01..07 S5 independent UI state', () => {
  it('groups only authorized models by the six frozen types and sorts IDs', () => {
    const groups = groupModelsByType(models);
    expect(groups.map((group) => group.type)).toEqual(['llm', 'embedding']);
    expect(groups[0]?.models.map((model) => model.modelId)).toEqual(['llm-a', 'llm-b']);
    expect(
      groups.flatMap((group) => group.models).some((model) => model.modelId === 'hidden'),
    ).toBe(false);
  });

  it('keeps drafts on conflict and gates save on validation', () => {
    const binding: S5ModelBindingView = {
      modelType: 'llm',
      modelId: 'llm-a',
      displayName: 'LLM A',
      requiredCapabilities: ['chat'],
      status: 'active',
    };
    expect(mergeBindingDraft([], binding)).toEqual([binding]);
    expect(safeConflictRetryState('conflict', 1)).toEqual({
      state: 'conflict',
      keepDraft: true,
    });
    expect(canSaveBinding({ state: 'ready', bindings: [binding] })).toBe(true);
    expect(canSaveBinding({ state: 'conflict', bindings: [binding] })).toBe(false);
  });

  it('maps permission, conflict, partial and 504 errors to stable states and message keys', () => {
    expect(stateFromProblem(problem(409, 'KNOWLEDGE_CONFLICT'))).toBe('conflict');
    expect(stateFromProblem(problem(403, 'KNOWLEDGE_FORBIDDEN'))).toBe('forbidden');
    expect(stateFromProblem(problem(504, 'KNOWLEDGE_DEPENDENCY_TIMEOUT'))).toBe('timeout');
    expect(stateFromProblem(problem(207, 'KNOWLEDGE_PARTIAL_SUCCESS'))).toBe('partial');
    expect(stateFromProblem(problem(400, 'KNOWLEDGE_VALIDATION_FAILED'))).toBe('validation');
    const view = toS5ProblemView(problem(409, 'KNOWLEDGE_CONFLICT'));
    expect(view).toMatchObject({
      messageKey: 'errors.conflict',
      params: { field: 'version', status: 409 },
      traceId: 'trace-a',
      requestId: 'request-a',
    });
    expect(view.messageKey).not.toContain('backend text');
  });

  it('never labels mock or unverified providers as real', () => {
    expect(providerVerificationLabel({ mode: 'mock', verified: true })).toBe('mock');
    expect(providerVerificationLabel({ mode: 'real', verified: false })).toBe('unverified');
    expect(providerVerificationLabel({ mode: 'external', verified: true })).toBe('real');
  });

  it('validates parser, chunking and credential reference forms without unknown fields', () => {
    expect(
      s5LiteParseConfigFormSchema.safeParse({
        provider: 'liteparse',
        ocrEnabled: false,
        maxPages: 100,
        batchPages: 10,
        fallbackPdfJsOnWasmLoadError: true,
        timeoutMs: 10_000,
      }).success,
    ).toBe(true);
    expect(
      s5ExternalOcrConfigFormSchema.safeParse({
        provider: 'textin',
        credentialProfileId: 'env:OCR_PROFILE',
        fallbackProvider: 'liteparse',
        imageHandling: 'upload_to_storage',
        timeoutMs: 10_000,
      }).success,
    ).toBe(true);
    expect(
      parseChunkingSettingsDraft({
        trainingType: 'chunk',
        chunkSettingMode: 'custom',
      }),
    ).toMatchObject({ success: false, errors: { chunkSize: expect.any(String) } });
    expect(
      parseChunkingSettingsDraft({
        trainingType: 'qa',
        chunkSettingMode: 'custom',
        chunkSize: 512,
        chunkSplitMode: 'char',
        qaPrompt: 'Use concise answers.',
      }).success,
    ).toBe(true);
    expect(
      parseChunkingSettingsDraft({
        trainingType: 'chunk',
        chunkSettingMode: 'auto',
        unknown: true,
      }).success,
    ).toBe(false);
  });

  it('keeps phase1 components independent from pages, query keys and the shared API client', () => {
    const root = join(import.meta.dirname, '..', '..', 'src');
    const files = [
      join(root, 'components', 's5-model-binding.tsx'),
      join(root, 'components', 's5-parse-settings.tsx'),
      join(root, 'components', 's5-model-parse-state.ts'),
      join(root, 'forms', 's5-model-parse-form.ts'),
    ];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const forbidden of [
        'knowledge-client',
        'knowledge-query-keys',
        'knowledge-shell',
        'projects/app',
        '/pages/',
        'dangerouslySetInnerHTML',
      ]) {
        expect(content, `${file}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
