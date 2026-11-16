import { describe, expect, it } from 'vitest';
import { createDefaultDocumentParser } from '../../packages/parse/src/index';
import { S5OcrHttpAdapter } from '../../packages/service/src/modules/knowledge/adapter/s5-ocr-http.adapter';
import type {
  OcrCredentialProfilePort,
  S5OcrHttpRequest,
  S5OcrHttpResponse,
  S5OcrHttpTransportPort,
  S5OcrProviderConfig,
} from '../../packages/service/src/modules/knowledge/application/s5-ocr-ports';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_b11_concurrency',
  memberId: 'mem_b11_concurrency',
  requestId: 'req-b11-concurrency',
  traceId: 'trace-b11-concurrency',
  scopes: ['knowledge:read', 'knowledge:write'],
};

describe('L1-B11-A parse and OCR concurrency isolation', () => {
  it('L1-B11-A-PARSE-001-C02 concurrent files never exchange text, hash or parser metadata', async () => {
    const parser = createDefaultDocumentParser();
    const inputs = Array.from({ length: 24 }, (_, index) => ({
      extension: index % 2 === 0 ? 'txt' : 'md',
      text: `B11 concurrent document ${index} ${'x'.repeat(index)}`,
    }));
    const results = await Promise.all(
      inputs.map((input, index) =>
        parser.parse({
          workspaceId: context.workspaceId,
          knowledgeSpaceId: 'space-b11-concurrency',
          sourceId: `source-${index}`,
          fileRef: `b11-${index}.${input.extension}`,
          extension: input.extension,
          mimeType: input.extension === 'txt' ? 'text/plain' : 'text/markdown',
          timeoutMs: 10_000,
          bytes: Buffer.from(input.text),
        }),
      ),
    );
    const hashes = new Set(results.map((result) => result.contentHash));
    expect(hashes.size).toBe(inputs.length);
    results.forEach((result, index) => {
      expect(result.rawText).toBe(inputs[index]!.text);
      expect(result.rawText).not.toContain(`document ${(index + 1) % inputs.length} `);
      expect(result.format).toBe(index % 2 === 0 ? 'text' : 'markdown');
    });
  });

  it('L1-B11-A-PARSE-002-C01 concurrent Provider calls keep credential, request and output identity separate', async () => {
    const profiles: OcrCredentialProfilePort = {
      async resolve(profileId) {
        return {
          endpoint: 'https://ocr.example.invalid',
          credentials: {
            appId: profileId.endsWith('A') ? 'app-a' : 'app-b',
            secretCode: profileId.endsWith('A') ? 'secret-a' : 'secret-b',
          },
        };
      },
    };
    const calls: S5OcrHttpRequest[] = [];
    const transport: S5OcrHttpTransportPort = {
      async request<T>(request): Promise<S5OcrHttpResponse<T>> {
        calls.push(request);
        const body = Buffer.from(request.body as Uint8Array).toString('utf8');
        await new Promise((resolve) => setTimeout(resolve, body.includes('A') ? 20 : 1));
        return {
          status: 200,
          headers: {},
          data: {
            code: 200,
            markdown: `result-${body}`,
            pages: [{ pageNumber: 1, markdown: `result-${body}` }],
          },
        };
      },
    };
    const adapter = new S5OcrHttpAdapter({ profiles, transport });
    const makeConfig = (suffix: 'A' | 'B'): S5OcrProviderConfig => ({
      provider: 'textin',
      credentialProfileId: `env:PROFILE_${suffix}`,
      timeoutMs: 10_000,
      fallbackProvider: 'none',
      imageHandling: 'drop',
      removeWatermark: true,
      parseMode: 'auto',
    });
    const makeRequest = (suffix: 'A' | 'B') => ({
      workspaceId: context.workspaceId,
      sourceId: `source-${suffix}`,
      sourceVersion: 1,
      bytes: Buffer.from(`B11-${suffix}`),
      fileName: `b11-${suffix}.pdf`,
      mimeType: 'application/pdf',
      config: makeConfig(suffix),
      timeoutMs: 10_000,
      requestId: `request-${suffix}`,
      traceId: `trace-${suffix}`,
    });
    const [resultA, resultB] = await Promise.all([
      adapter.parse(makeRequest('A'), context),
      adapter.parse(makeRequest('B'), context),
    ]);
    expect(resultA.markdown).toBe('result-B11-A');
    expect(resultB.markdown).toBe('result-B11-B');
    expect(resultA.markdown).not.toContain('B11-B');
    expect(resultB.markdown).not.toContain('B11-A');

    const requestA = calls.find((call) => call.headers['x-ti-app-id'] === 'app-a');
    const requestB = calls.find((call) => call.headers['x-ti-app-id'] === 'app-b');
    expect(Buffer.from(requestA?.body as Uint8Array).toString('utf8')).toBe('B11-A');
    expect(Buffer.from(requestB?.body as Uint8Array).toString('utf8')).toBe('B11-B');
    expect(requestA?.headers['x-ti-secret-code']).toBe('secret-a');
    expect(requestB?.headers['x-ti-secret-code']).toBe('secret-b');
  });
});
