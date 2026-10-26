import { describe, expect, it } from 'vitest';
import { KnowledgeCredentialCipher } from '../../src/modules/knowledge/adapter/credential-cipher';
import { isForbiddenAddress, validateUrlSyntax } from '../../src/modules/knowledge/adapter/ssrf';

const context = { requestId: 'req', traceId: 'trace' };
const aad = {
  workspaceId: 'ws',
  knowledgeSpaceId: '65f1e5b2a1c9d4b7e8f01234',
  provider: 'feishu',
  schemaVersion: 1,
};

describe('S4 credential cipher', () => {
  it('encrypts with a versioned AES-GCM envelope and decrypts with matching AAD', () => {
    const cipher = new KnowledgeCredentialCipher('x'.repeat(32));
    const encrypted = cipher.encrypt(
      { provider: 'feishu', appId: 'app', appSecret: 'super-secret' },
      aad,
    );
    expect(encrypted.keyVersion).toBe(1);
    expect(encrypted.ciphertext).not.toContain('super-secret');
    expect(JSON.parse(encrypted.ciphertext)).toMatchObject({
      v: 1,
      alg: 'A256GCM',
      keyVersion: 1,
    });
    expect(cipher.decrypt(encrypted.ciphertext, aad)).toEqual({
      provider: 'feishu',
      appId: 'app',
      appSecret: 'super-secret',
    });
    expect(() => cipher.decrypt(encrypted.ciphertext, { ...aad, workspaceId: 'other' })).toThrow();
  });

  it('rejects short keys', () => {
    expect(() => new KnowledgeCredentialCipher('short')).toThrow();
  });
});

describe('S4 SSRF guard', () => {
  it('blocks private, loopback, link-local, multicast and IPv4-mapped IPv6', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '224.0.0.1',
      '::1',
      'fc00::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isForbiddenAddress(address), address).toBe(true);
    }
    expect(isForbiddenAddress('8.8.8.8')).toBe(false);
    expect(isForbiddenAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('rejects non-http, userinfo and private literal URLs without network access', () => {
    expect(() => validateUrlSyntax('file:///etc/passwd', context)).toThrow();
    expect(() => validateUrlSyntax('https://user:pass@example.com', context)).toThrow();
    expect(() => validateUrlSyntax('http://169.254.169.254', context)).toThrow();
  });
});
