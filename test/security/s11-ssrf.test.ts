import { describe, expect, it } from 'vitest';
import { KnowledgeUrlImportAdapter } from '../../packages/service/src/modules/knowledge/adapter/url-import';
import {
  isForbiddenAddress,
  validateUrlSyntax,
  validateUrlTarget,
} from '../../packages/service/src/modules/knowledge/adapter/ssrf';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_s11_security',
  memberId: 'mem_s11_security',
  requestId: 'req_s11_security',
  traceId: 'trace_s11_security',
  scopes: ['knowledge:write'],
};

function privateIpMatrix() {
  return [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
  ];
}

describe('TEST-X-SECURITY-URL', () => {
  it('rejects the private, link-local, multicast, metadata and mapped IPv6 matrix', () => {
    for (const address of privateIpMatrix()) {
      expect(isForbiddenAddress(address), address).toBe(true);
    }
    for (const url of [
      'http://127.0.0.1',
      'http://[::1]',
      'http://169.254.169.254/latest/meta-data',
      'http://localhost',
      'http://metadata.google.internal',
    ]) {
      expect(() => validateUrlSyntax(url, context), url).toThrow();
    }
  });

  it('rejects a DNS answer set if any answer is private', async () => {
    await expect(
      validateUrlTarget('https://mixed.example.test', context, async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.8', family: 4 },
      ]),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_UNSUPPORTED_CONTENT' } },
    });
  });

  it('fails closed after five redirects without reaching a private target', async () => {
    let requests = 0;
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
        requests += 1;
        return {
          status: 302,
          location: `https://example.com/redirect-${requests}`,
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
    expect(requests).toBe(6);
  });
});
