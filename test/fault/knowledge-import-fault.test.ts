import { describe, expect, it } from 'vitest';
import { KnowledgeCredentialCipher } from '../../packages/service/src/modules/knowledge/adapter/credential-cipher';
import {
  isForbiddenAddress,
  validateUrlSyntax,
} from '../../packages/service/src/modules/knowledge/adapter/ssrf';
import { KnowledgeUrlImportAdapter } from '../../packages/service/src/modules/knowledge/adapter/url-import';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws-fault',
  memberId: 'mem-fault',
  requestId: 'req-fault',
  traceId: 'trace-fault',
  scopes: ['knowledge:write'],
};

describe('TEST-X-S4-FAULT import boundaries', () => {
  it('blocks private URL targets without making a request', () => {
    expect(() => validateUrlSyntax('http://127.0.0.1', context)).toThrow();
    expect(isForbiddenAddress('169.254.169.254')).toBe(true);
  });

  it('fails closed after five redirects', async () => {
    let calls = 0;
    const adapter = new KnowledgeUrlImportAdapter({
      async resolve(raw) {
        return {
          url: new URL(raw),
          address: '93.184.216.34',
          family: 4,
          addresses: ['93.184.216.34'],
        };
      },
      async requestPage() {
        calls += 1;
        return {
          status: 302,
          location: `https://example.com/redirect-${calls}`,
          contentType: 'text/html',
          bytes: new Uint8Array(),
        };
      },
    });
    await expect(
      adapter.fetch({ url: 'https://example.com/start', selector: 'body', context }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' } },
    });
    expect(calls).toBe(6);
  });

  it('detects AES-GCM AAD tampering rather than returning credentials', () => {
    const cipher = new KnowledgeCredentialCipher('k'.repeat(32));
    const aad = {
      workspaceId: context.workspaceId,
      knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
      provider: 'feishu',
      schemaVersion: 1,
    };
    const encrypted = cipher.encrypt({ provider: 'feishu', appId: 'id', appSecret: 'secret' }, aad);
    expect(() => cipher.decrypt(encrypted.ciphertext, { ...aad, provider: 'yuque' })).toThrow();
  });
});
