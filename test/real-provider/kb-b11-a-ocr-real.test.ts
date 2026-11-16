import { describe, expect, it } from 'vitest';
import { AxiosS5OcrHttpTransport } from '../../packages/service/src/modules/knowledge/adapter/s5-ocr-http.adapter';
import { S5OcrHttpAdapter } from '../../packages/service/src/modules/knowledge/adapter/s5-ocr-http.adapter';
import { S5OcrCredentialProfileAdapter } from '../../packages/service/src/modules/knowledge/adapter/s5-ocr-profile.adapter';
import type {
  S5OcrProviderConfig,
  S5OcrRequest,
} from '../../packages/service/src/modules/knowledge/application/s5-ocr-ports';
import { S5OcrProviderError } from '../../packages/service/src/modules/knowledge/application/s5-ocr-ports';
import {
  fixturePdf,
  providerContext,
  requiredProviderEnv,
  safeHostHash,
  sha256,
  writeProviderEvidence,
} from './s11-real-helpers';

const providers = ['somark', 'textin', 'doc2x'] as const;

function profileId(provider: (typeof providers)[number]) {
  const name = `S11_OCR_${provider.toUpperCase()}_PROFILE_JSON`;
  requiredProviderEnv(name);
  return `env:${name}`;
}

function configFor(provider: (typeof providers)[number]): S5OcrProviderConfig {
  if (provider === 'textin') {
    return {
      provider,
      credentialProfileId: profileId(provider),
      timeoutMs: 120_000,
      fallbackProvider: 'none',
      imageHandling: 'drop',
      removeWatermark: true,
      parseMode: 'auto',
    };
  }
  if (provider === 'doc2x') {
    return {
      provider,
      credentialProfileId: profileId(provider),
      timeoutMs: 120_000,
      fallbackProvider: 'none',
      imageHandling: 'drop',
      pollIntervalMs: 1_000,
    };
  }
  return {
    provider,
    credentialProfileId: profileId(provider),
    timeoutMs: 120_000,
    fallbackProvider: 'none',
    imageHandling: 'drop',
  };
}

function requestFor(provider: (typeof providers)[number], bytes: Uint8Array): S5OcrRequest {
  return {
    workspaceId: providerContext.workspaceId,
    sourceId: `65f1e5b2a1c9d4b7e8f1${provider === 'somark' ? '0001' : provider === 'textin' ? '0002' : '0003'}`,
    sourceVersion: 1,
    bytes,
    fileName: 's11-two-page.pdf',
    mimeType: 'application/pdf',
    config: configFor(provider),
    timeoutMs: 120_000,
    requestId: `req-b11-${provider}`,
    traceId: `trace-b11-${provider}`,
  };
}

function endpointFor(provider: (typeof providers)[number]): string {
  const envName = `S11_OCR_${provider.toUpperCase()}_PROFILE_JSON`;
  const value = JSON.parse(requiredProviderEnv(envName)) as { endpoint?: unknown };
  return typeof value.endpoint === 'string' ? value.endpoint : '';
}

describe('L1-B11-A PARSE-002 real OCR providers', () => {
  for (const provider of providers) {
    it(`L1-B11-A-PARSE-002-P01 ${provider} returns verified pages, markdown and usage`, async () => {
      const adapter = new S5OcrHttpAdapter({
        profiles: new S5OcrCredentialProfileAdapter(process.env),
        transport: new AxiosS5OcrHttpTransport(),
      });
      const bytes = fixturePdf();
      const request = requestFor(provider, bytes);
      const started = performance.now();
      try {
        const result = await adapter.parse(request, providerContext);
        const elapsedMs = Math.round(performance.now() - started);

        expect(result.markdown.trim().length).toBeGreaterThan(0);
        expect(result.pages.length).toBeGreaterThanOrEqual(2);
        expect(result.pages.map((item) => item.pageNumber)).toEqual(
          [...result.pages].map((item) => item.pageNumber).sort((left, right) => left - right),
        );
        expect(result.usage.length).toBeGreaterThan(0);
        expect(result.usage.every((usage) => usage.quantity > 0)).toBe(true);
        expect(JSON.stringify(result.requestEvidence)).not.toMatch(
          /authorization|api[-_]?key|secretCode|signature|https?:\/\//i,
        );

        writeProviderEvidence(`b11-a-${provider}.json`, {
          status: 'REAL_VERIFIED',
          provider,
          endpointHostHash: safeHostHash(endpointFor(provider)),
          requestId: request.requestId,
          traceId: request.traceId,
          upstreamRequestId:
            result.requestEvidence.requestId ?? result.requestEvidence.request_id ?? null,
          fixtureSha256: sha256(bytes),
          inputPages: 2,
          outputPages: result.pages.length,
          markdownSha256: sha256(result.markdown),
          imageCount: result.assets.filter((asset) => asset.sourceUrl).length,
          objectRefCount: result.assets.filter((asset) => asset.objectRefId).length,
          imageHandling: 'drop',
          usage: result.usage.map((usage) => ({
            provider: usage.provider,
            unit: usage.unit,
            quantity: usage.quantity,
            status: usage.status,
          })),
          attempt: 1,
          actualProvider: provider,
          fallbackUsed: false,
          elapsedMs,
        });
      } catch (error) {
        const providerError = error instanceof S5OcrProviderError ? error : null;
        const blocked = ['auth', 'quota', 'rate_limit', 'timeout'].includes(
          providerError?.kind ?? '',
        );
        writeProviderEvidence(`b11-a-${provider}.json`, {
          status: blocked ? 'BLOCKED_PROVIDER' : 'FAIL',
          provider,
          endpointHostHash: safeHostHash(endpointFor(provider)),
          requestId: request.requestId,
          traceId: request.traceId,
          fixtureSha256: sha256(bytes),
          inputPages: 2,
          outputPages: null,
          markdownSha256: null,
          imageCount: 0,
          objectRefCount: 0,
          imageHandling: 'drop',
          usage:
            providerError?.usage.map((usage) => ({
              provider: usage.provider,
              unit: usage.unit,
              quantity: usage.quantity,
              status: usage.status,
            })) ?? [],
          attempt: 1,
          actualProvider: provider,
          fallbackUsed: false,
          elapsedMs: Math.round(performance.now() - started),
          errorKind: providerError?.kind ?? 'unexpected',
          upstreamStatus: providerError?.status ?? null,
        });
        throw error;
      }
    }, 180_000);
  }
});
