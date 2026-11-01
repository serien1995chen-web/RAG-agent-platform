import { describe, expect, it } from 'vitest';
import { redactExternalValue } from '../../packages/service/src/modules/knowledge/adapter/external-providers';
import { safeUrlForStorage } from '../../packages/service/src/modules/knowledge/adapter/ssrf';

describe('TEST-X-SECRET-LEAK', () => {
  it('redacts credentials, authorization, cookies, API keys and object keys recursively', () => {
    const redacted = redactExternalValue({
      provider: 'feishu',
      modelId: 'safe-model-id',
      authorization: 'Bearer hidden',
      nested: {
        token: 'hidden-token',
        appSecret: 'hidden-secret',
        cookie: 'session=hidden',
        apiKey: 'kn_live_hidden',
        objectKey: 'workspace/private/object',
      },
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).toContain('safe-model-id');
    expect(serialized).toContain('[REDACTED]');
    for (const secret of ['hidden-token', 'hidden-secret', 'session=hidden', 'kn_live_hidden']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('removes query, fragment and userinfo from stored URLs', () => {
    expect(safeUrlForStorage('https://user:password@example.test/path?token=hidden#fragment')).toBe(
      'https://example.test/path',
    );
  });
});
