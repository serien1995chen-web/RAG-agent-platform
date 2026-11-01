import { describe, expect, it } from 'vitest';
import { AxiosS5OcrHttpTransport } from '../../packages/service/src/modules/knowledge/adapter/s5-ocr-http.adapter';
import { S5OcrHttpAdapter } from '../../packages/service/src/modules/knowledge/adapter/s5-ocr-http.adapter';
import { S5OcrCredentialProfileAdapter } from '../../packages/service/src/modules/knowledge/adapter/s5-ocr-profile.adapter';
import type { S5OcrRequest } from '../../packages/service/src/modules/knowledge/application/s5-ocr-ports';
import {
  fixturePdf,
  providerContext,
  safeHostHash,
  sha256,
  writeProviderEvidence,
} from './s11-real-helpers';

const providers = ['somark', 'textin', 'doc2x'] as const;

function profileEnv(provider: (typeof providers)[number]): string {
  return `S11_OCR_${provider.toUpperCase()}_PROFILE_JSON`;
}

function requestFor(provider: (typeof providers)[number], bytes: Uint8Array): S5OcrRequest {
  const common = {
    workspaceId: providerContext.workspaceId,
    sourceId: `source-s11-${provider}`,
    sourceVersion: 1,
    bytes,
    fileName: 's11-two-page.pdf',
    mimeType: 'application/pdf',
    timeoutMs: 120_000,
    requestId: providerContext.requestId,
    traceId: providerContext.traceId,
  };
  if (provider === 'textin') {
    return {
      ...common,
      config: {
        provider,
        credentialProfileId: `env:${profileEnv(provider)}`,
        timeoutMs: 120_000,
        fallbackProvider: 'none',
        imageHandling: 'drop',
        removeWatermark: true,
        parseMode: 'auto',
      },
    };
  }
  if (provider === 'doc2x') {
    return {
      ...common,
      config: {
        provider,
        credentialProfileId: `env:${profileEnv(provider)}`,
        timeoutMs: 120_000,
        fallbackProvider: 'none',
        imageHandling: 'drop',
        pollIntervalMs: 1_000,
      },
    };
  }
  return {
    ...common,
    config: {
      provider,
      credentialProfileId: `env:${profileEnv(provider)}`,
      timeoutMs: 120_000,
      fallbackProvider: 'none',
      imageHandling: 'drop',
    },
  };
}

describe('TEST-X-S11-PROVIDER-REAL OCR', () => {
  it('Somark, TextIn and Doc2X return two pages, markdown and usage', async () => {
    const adapter = new S5OcrHttpAdapter({
      profiles: new S5OcrCredentialProfileAdapter(process.env),
      transport: new AxiosS5OcrHttpTransport(),
    });
    const bytes = fixturePdf();
    const results: Record<
      string,
      {
        pages: number;
        markdownSha256: string;
        usage: Array<{
          provider: string;
          unit: string;
          quantity: number;
          status: number | null;
        }>;
      }
    > = {};
    for (const provider of providers) {
      const result = await adapter.parse(requestFor(provider, bytes), providerContext);
      expect(result.markdown.trim().length).toBeGreaterThan(0);
      expect(result.pages.length).toBeGreaterThanOrEqual(2);
      expect(result.usage.length).toBeGreaterThan(0);
      expect(result.usage.every((usage) => usage.quantity > 0)).toBe(true);
      results[provider] = {
        pages: result.pages.length,
        markdownSha256: sha256(result.markdown),
        usage: result.usage.map((usage) => ({
          provider: usage.provider,
          unit: usage.unit,
          quantity: usage.quantity,
          status: usage.status,
        })),
      };
    }
    const profileHosts = Object.fromEntries(
      providers.map((provider) => {
        const raw = process.env[profileEnv(provider)] ?? '{}';
        const endpoint = (JSON.parse(raw) as { endpoint?: string }).endpoint ?? '';
        return [provider, endpoint ? safeHostHash(endpoint) : null];
      }),
    );
    writeProviderEvidence('t02-ocr.json', {
      status: 'REAL_VERIFIED',
      sangfor: 'DEFERRED_BY_SCOPE',
      sangforRealCalls: 0,
      fixtureSha256: sha256(bytes),
      profileHosts,
      results,
    });
  });
});
