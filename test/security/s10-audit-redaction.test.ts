import { describe, expect, it } from 'vitest';
import {
  KnowledgeAuditRepository,
  safeAuditDiff,
} from '../../packages/service/src/shared/persistence/knowledge/audit';

describe('TEST-X-SECRET-LEAK audit redaction', () => {
  it('redacts credentials, content, object keys, raw IP and user agent', () => {
    const result = safeAuditDiff({
      action: 'source.create',
      authorization: 'Bearer kn_live_secret',
      secret: 'secret-value',
      objectKey: 'tenant/object/key',
      body: 'private content',
      prompt: 'private prompt',
      answer: 'private answer',
      ip: '203.0.113.10',
      userAgent: 'raw agent',
      safe: {
        sourceVersion: 2,
        tags: ['a', 'b'],
      },
    }) as Record<string, unknown>;
    expect(result).toMatchObject({
      action: 'source.create',
      authorization: '[REDACTED]',
      secret: '[REDACTED]',
      objectKey: '[REDACTED]',
      body: '[REDACTED]',
      prompt: '[REDACTED]',
      answer: '[REDACTED]',
      ip: '[REDACTED]',
      userAgent: '[REDACTED]',
      safe: { sourceVersion: 2, tags: ['a', 'b'] },
    });
    expect(JSON.stringify(result)).not.toContain('kn_live_secret');
    expect(JSON.stringify(result)).not.toContain('203.0.113.10');
  });

  it('bounds recursive input and keeps audit repository append-only', async () => {
    const deep = { one: { two: { three: { four: { five: { six: { seven: 'hidden' } } } } } } };
    expect(JSON.stringify(safeAuditDiff(deep))).toContain('[REDACTED]');
    const repository = new KnowledgeAuditRepository({} as never);
    await expect(repository.update()).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
    await expect(repository.delete()).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } },
    });
  });
});
