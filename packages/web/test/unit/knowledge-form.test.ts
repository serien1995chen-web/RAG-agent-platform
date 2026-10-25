import { describe, expect, it, vi } from 'vitest';
import { KnowledgeRequestError } from '../../src/client/knowledge-client';
import {
  fieldErrorsFromProblem,
  newSpaceFormSchema,
  sourceFormSchema,
  tagFormSchema,
} from '../../src/forms/knowledge-form';

describe('knowledge form schemas', () => {
  it('accepts the existing page constraints and rejects invalid enum values', () => {
    expect(
      newSpaceFormSchema.safeParse({
        kind: 'space',
        name: 'Knowledge',
        description: '',
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      }).success,
    ).toBe(true);
    expect(
      sourceFormSchema.safeParse({
        kind: 'text',
        name: 'Source',
        directoryId: '',
      }).success,
    ).toBe(true);
    expect(
      newSpaceFormSchema.safeParse({
        kind: 'unknown',
        name: 'Knowledge',
        description: '',
        accessMode: 'workspace',
        sourceAclMode: 'enforced',
        sourcePermissionEnabled: true,
      }).success,
    ).toBe(false);
  });

  it('preserves the existing tag key, label and type rules', () => {
    expect(
      tagFormSchema.safeParse({
        key: 'source_type',
        label: 'Source type',
        tagType: 'string',
        options: 'a,b',
        required: false,
      }).success,
    ).toBe(true);
    expect(
      tagFormSchema.safeParse({
        key: 'Invalid Key',
        label: 'Source type',
        tagType: 'string',
        options: 'a,b',
        required: false,
      }).success,
    ).toBe(false);
  });

  it('maps only the declared Problem field into a local form error', () => {
    const problem = new KnowledgeRequestError(400, {
      success: false,
      error: {
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        message: 'backend text must not become local copy',
        retryable: false,
        details: { field: 'name' },
      },
      traceId: 'trace-a',
      requestId: 'request-a',
    });
    expect(fieldErrorsFromProblem(problem)).toEqual({
      name: 'KNOWLEDGE_VALIDATION_FAILED',
    });
    expect(fieldErrorsFromProblem(new Error('network'))).toEqual({});
  });

  it('returns false and preserves the caught problem without throwing', async () => {
    const problem = new Error('offline');
    const setProblem = vi.fn();
    const { submitWithProblem } = await import('../../src/forms/knowledge-form');
    await expect(
      submitWithProblem(async () => {
        throw problem;
      }, setProblem),
    ).resolves.toBe(false);
    expect(setProblem).toHaveBeenCalledWith(problem);
  });
});
