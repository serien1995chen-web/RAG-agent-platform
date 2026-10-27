import { describe, expect, it } from 'vitest';
import { KnowledgeCredentialCipher } from '../../packages/service/src/modules/knowledge/adapter/credential-cipher';
import {
  isForbiddenAddress,
  validateUrlSyntax,
  validateUrlTarget,
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
  it('TEST-ING-003-U01 blocks loopback/private/link-local/IPv6 ULA targets', () => {
    for (const url of [
      'http://127.0.0.1',
      'http://10.0.0.1',
      'http://192.168.1.1',
      'http://169.254.169.254',
      'http://[fc00::1]',
      'http://[fe80::1]',
    ]) {
      expect(() => validateUrlSyntax(url, context), url).toThrow();
    }
    expect(isForbiddenAddress('169.254.169.254')).toBe(true);
  });

  it('TEST-ING-003-U02 blocks cloud metadata before the network request', async () => {
    let requests = 0;
    const adapter = new KnowledgeUrlImportAdapter({
      async requestPage() {
        requests += 1;
        throw new Error('network must not be reached');
      },
    });
    await expect(
      adapter.fetch({
        url: 'http://169.254.169.254/latest/meta-data',
        selector: 'body',
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' } },
    });
    expect(requests).toBe(0);
  });

  it('TEST-ING-003-U03 rejects DNS answers containing any private address', async () => {
    await expect(
      validateUrlTarget('https://mixed.example.test', context, async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.8', family: 4 },
      ]),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' } },
    });
  });

  it('TEST-ING-003-U04 fails closed after five redirects', async () => {
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

  it('TEST-ING-003-U05 maps timeout to 504 and size overflow to 413', async () => {
    for (const [code, message] of [
      ['KNOWLEDGE_DEPENDENCY_TIMEOUT', 'timeout'],
      ['KNOWLEDGE_PAYLOAD_TOO_LARGE', 'too-large'],
    ] as const) {
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
          throw Object.assign(new Error(message), {
            problem: { error: { code } },
          });
        },
      });
      await expect(
        adapter.fetch({ url: 'https://example.com/file', selector: 'body', context }),
      ).rejects.toMatchObject({ problem: { error: { code } } });
    }
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
