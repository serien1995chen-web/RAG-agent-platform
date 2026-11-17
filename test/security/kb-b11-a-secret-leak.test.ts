import { describe, expect, it } from 'vitest';
import { S5OcrCredentialProfileAdapter } from '../../packages/service/src/modules/knowledge/adapter/s5-ocr-profile.adapter';
import { S5OcrHttpAdapter } from '../../packages/service/src/modules/knowledge/adapter/s5-ocr-http.adapter';
import type {
  S5OcrHttpResponse,
  S5OcrHttpTransportPort,
  S5OcrProviderConfig,
} from '../../packages/service/src/modules/knowledge/application/s5-ocr-ports';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_b11_security',
  memberId: 'mem_b11_security',
  requestId: 'req-b11-security',
  traceId: 'trace-b11-security',
  scopes: ['knowledge:read', 'knowledge:write'],
};

const config: S5OcrProviderConfig = {
  provider: 'somark',
  credentialProfileId: 'env:B11_SECRET_PROFILE',
  timeoutMs: 10_000,
  fallbackProvider: 'none',
  imageHandling: 'drop',
};

describe('L1-B11-A PARSE credential secrecy', () => {
  it('L1-B11-A-PARSE-002-Q01 never serializes raw credential profiles, tokens or signed URLs', async () => {
    const secret = 'B11-SUPER-SECRET-TOKEN';
    const profiles = new S5OcrCredentialProfileAdapter({
      B11_BAD_PROFILE: `{"endpoint":"https://ocr.example.invalid","credentials":{"apiKey":"${secret}"`,
      B11_SECRET_PROFILE: JSON.stringify({
        endpoint: 'https://ocr.example.invalid',
        credentials: { apiKey: secret },
      }),
    });
    const bad = await profiles.resolve('env:B11_BAD_PROFILE', 'somark').catch((error) => error);
    expect(bad).toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    expect(JSON.stringify(bad)).not.toContain(secret);
    expect(JSON.stringify(bad)).not.toContain('https://ocr.example.invalid');

    const transport: S5OcrHttpTransportPort = {
      async request<T>() {
        return {
          status: 200,
          headers: {
            location: 'https://cdn.example.invalid/object?signature=private',
            authorization: `Bearer ${secret}`,
          },
          data: {
            code: 0,
            markdown: 'safe body',
            pages: [{ pageNumber: 1, markdown: 'safe body' }],
          },
        } as S5OcrHttpResponse<T>;
      },
    };
    const result = await new S5OcrHttpAdapter({ profiles, transport }).parse(
      {
        workspaceId: context.workspaceId,
        sourceId: 'source-b11-security',
        sourceVersion: 1,
        bytes: Buffer.from('%PDF-1.4'),
        fileName: 'b11.pdf',
        mimeType: 'application/pdf',
        config,
        timeoutMs: 10_000,
        requestId: context.requestId,
        traceId: context.traceId,
      },
      context,
    );
    expect(JSON.stringify(result.requestEvidence)).not.toContain(secret);
    expect(JSON.stringify(result.requestEvidence)).not.toMatch(
      /https?:\/\/|authorization|signature/i,
    );
  });
});
