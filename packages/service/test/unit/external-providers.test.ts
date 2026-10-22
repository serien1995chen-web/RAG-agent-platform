import { describe, expect, it } from 'vitest';
import {
  AiproxyMockAdapter,
  ConnectorMockAdapter,
  EXTERNAL_UNVERIFIED,
  OcrMockAdapter,
  classifyExternalFailure,
  redactExternalValue,
} from '../../src/modules/knowledge/adapter/external-providers';

describe('external provider contracts', () => {
  it('exposes an explicit non-empty AIProxy mock catalog with four dimensions', async () => {
    const adapter = new AiproxyMockAdapter({
      kind: 'aiproxy',
      baseUrl: 'https://aiproxy.invalid',
      apiKeyRef: 'env:AIPROXY_KEY',
      timeoutMs: 5_000,
      status: EXTERNAL_UNVERIFIED,
    });
    const models = await adapter.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(
      models.filter((model) => model.type === 'embedding').map((model) => model.dimension),
    ).toEqual([768, 1024, 1536, 3072]);
    expect(adapter).toBeDefined();
  });

  it('classifies timeouts, auth, rate limits and contract violations', () => {
    expect(classifyExternalFailure({ timeout: true })).toMatchObject({
      kind: 'timeout',
      retryable: true,
    });
    expect(classifyExternalFailure({ status: 401 })).toMatchObject({
      kind: 'auth',
      retryable: false,
    });
    expect(classifyExternalFailure({ status: 429 })).toMatchObject({
      kind: 'rate_limit',
      retryable: true,
    });
    expect(classifyExternalFailure({ status: 503 })).toMatchObject({
      kind: 'unavailable',
      retryable: true,
    });
    expect(classifyExternalFailure({ contract: true })).toMatchObject({
      kind: 'contract',
      retryable: true,
    });
  });

  it('redacts credentials from arbitrary provider payloads', () => {
    expect(
      redactExternalValue({
        name: 'feishu',
        token: 'secret-token',
        nested: { appSecret: 'secret', region: 'cn' },
      }),
    ).toEqual({
      name: 'feishu',
      token: '[REDACTED]',
      nested: { appSecret: '[REDACTED]', region: 'cn' },
    });
  });

  it('provides OCR and connector mocks marked external-unverified', async () => {
    const ocr = new OcrMockAdapter({
      kind: 'ocr',
      provider: 'paddle',
      endpoint: 'https://ocr.invalid',
      credentialRef: 'env:OCR_KEY',
      timeoutMs: 5_000,
      fallbackProvider: 'paddle',
      status: EXTERNAL_UNVERIFIED,
    });
    await expect(
      ocr.parse({ fileName: 'scan.pdf', bytes: new Uint8Array([1]) }, 'req-ocr'),
    ).resolves.toMatchObject({ pages: 1, images: 0 });

    for (const provider of ['feishu', 'yuque', 'dingtalk'] as const) {
      const connector = new ConnectorMockAdapter({
        kind: 'connector',
        provider,
        endpoint: `https://${provider}.invalid`,
        appCredentialRef: 'env:APP_KEY',
        tenantCredentialRef: 'env:TENANT_KEY',
        timeoutMs: 5_000,
        status: EXTERNAL_UNVERIFIED,
      });
      await expect(connector.catalog('req-connector')).resolves.toMatchObject({
        provider,
        items: [expect.objectContaining({ externalId: `${provider}-doc-1` })],
      });
    }
  });
});
