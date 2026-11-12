import { describe, expect, it } from 'vitest';
import {
  ChunkingSettingsSchema,
  ImportTextSchema,
} from '../../packages/contracts/src/knowledge/ingestion-contract';
import { assertNonEmptyText } from '../../packages/service/src/modules/knowledge/domain/import-submission';
import {
  objectIdOf,
  requireWorkspaceId,
  type TenantContext,
} from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_b05_security',
  memberId: 'mem_b05_security',
  requestId: 'req_b05_security',
  traceId: 'b'.repeat(32),
  scopes: ['knowledge:read', 'knowledge:write'],
  isWorkspaceOwner: true,
};

function errorOf(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error as {
      problem?: { error?: { code?: string; details?: Record<string, unknown> } };
      message?: string;
    };
  }
  throw new Error('expected operation to throw');
}

describe('B05 manual data input and tenant security', () => {
  it('L1-B05-ING-002-Q01 enforces the 10,000,000 character and 10 MiB text boundaries', () => {
    const valid = 'x'.repeat(10_000_000);
    expect(
      ImportTextSchema.safeParse({
        knowledgeSpaceId: '507f1f77bcf86cd799439011',
        name: 'max',
        text: valid,
        chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
      }).success,
    ).toBe(true);
    expect(
      ImportTextSchema.safeParse({
        knowledgeSpaceId: '507f1f77bcf86cd799439011',
        name: 'too-long',
        text: `${valid}x`,
        chunking: { trainingType: 'chunk', chunkSettingMode: 'auto' },
      }).success,
    ).toBe(false);
    const multibyte = '知'.repeat(3_500_000);
    const error = errorOf(() => assertNonEmptyText(multibyte, context));
    expect(error.problem?.error).toMatchObject({
      code: 'KNOWLEDGE_PAYLOAD_TOO_LARGE',
      details: { field: 'text' },
    });
    expect(error.message).not.toContain('知'.repeat(64));
  });

  it('L1-B05-ING-002-N02 rejects whitespace, unknown chunking fields, and invalid provider values', () => {
    expect(() => assertNonEmptyText(' \n\t ', context)).toThrow();
    expect(
      ChunkingSettingsSchema.safeParse({
        trainingType: 'chunk',
        chunkSettingMode: 'auto',
        unknownField: true,
      }).success,
    ).toBe(false);
    expect(
      ChunkingSettingsSchema.safeParse({
        trainingType: 'chunk',
        chunkSettingMode: 'custom',
        chunkSplitMode: 'invalid',
      }).success,
    ).toBe(false);
  });

  it('L1-B05-DATA-004-A02 fails closed without workspace or member context', () => {
    expect(() => requireWorkspaceId({ ...context, workspaceId: '' })).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({ code: 'KNOWLEDGE_VALIDATION_FAILED' }),
        }),
      }),
    );
    expect(() => requireWorkspaceId({ ...context, memberId: ' ' })).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({
          error: expect.objectContaining({ code: 'KNOWLEDGE_VALIDATION_FAILED' }),
        }),
      }),
    );
    const malformed = errorOf(() => objectIdOf('not-an-object-id', context, 'sourceId'));
    expect(malformed.problem?.error).toMatchObject({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      details: { field: 'sourceId', reason: 'invalid_object_id' },
    });
    expect(malformed.message).not.toContain('CastError');
  });
});
