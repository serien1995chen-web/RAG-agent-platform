import { describe, expect, it } from 'vitest';
import { S5OcrApplication } from '../../packages/service/src/modules/knowledge/application/s5-ocr.application';
import {
  S5OcrProviderError,
  type S5OcrProviderConfig,
  type S5ProviderUsageFact,
  type S5ProviderUsageRecorderPort,
} from '../../packages/service/src/modules/knowledge/application/s5-ocr-ports';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_b11_fault',
  memberId: 'mem_b11_fault',
  requestId: 'req-b11-fault',
  traceId: 'trace-b11-fault',
  scopes: ['knowledge:read', 'knowledge:write'],
};

const config: S5OcrProviderConfig = {
  provider: 'somark',
  credentialProfileId: 'env:B11_SOMARK',
  timeoutMs: 10_000,
  fallbackProvider: 'liteparse',
  imageHandling: 'drop',
};

class Usage implements S5ProviderUsageRecorderPort {
  readonly facts: S5ProviderUsageFact[] = [];
  async recordProviderUsage(fact: S5ProviderUsageFact) {
    this.facts.push(fact);
    return true;
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: context.workspaceId,
    knowledgeSpaceId: 'space-b11-fault',
    sourceId: 'source-b11-fault',
    sourceVersion: 1,
    bytes: Buffer.from('%PDF-1.4 B11'),
    fileName: 'b11.pdf',
    mimeType: 'application/pdf',
    config,
    timeoutMs: 10_000,
    requestId: context.requestId,
    traceId: context.traceId,
    context,
    ...overrides,
  };
}

function application(inputProvider: {
  parse: () => Promise<never>;
  fallback?: () => Promise<never>;
}) {
  const usage = new Usage();
  return {
    usage,
    app: new S5OcrApplication({
      provider: { parse: inputProvider.parse },
      usage,
      remoteAssets: {
        async fetch() {
          throw new Error('unused');
        },
      },
      assetSink: {
        async putImage() {
          throw new Error('unused');
        },
      },
      sourceGuard: { async assertSource() {} },
      ...(inputProvider.fallback ? { fallbackPdf: inputProvider.fallback } : {}),
      sleep: async () => undefined,
    }),
  };
}

describe('L1-B11-A OCR timeout, retry and fallback faults', () => {
  it('L1-B11-A-PARSE-002-F05 caps timeout retries at three and records each failed attempt plus one fallback', async () => {
    let calls = 0;
    const { app, usage } = application({
      async parse() {
        calls += 1;
        throw new S5OcrProviderError(
          'timeout',
          null,
          [{ provider: 'somark', unit: 'request', quantity: 1, status: null }],
          true,
          false,
        );
      },
      async fallback() {
        return {
          markdown: 'fallback',
          pages: [{ pageNumber: 1, text: 'fallback', assets: [] }],
          assets: [],
          diagnostics: [],
        };
      },
    });
    const result = await app.parse(input());
    expect(calls).toBe(3);
    expect(result.attempts).toBe(3);
    expect(result.actualProvider).toBe('liteparse');
    expect(result.fallbackUsed).toBe(true);
    expect(usage.facts.map((fact) => [fact.provider, fact.attempt, fact.fallbackUsed])).toEqual([
      ['somark', 1, false],
      ['somark', 2, false],
      ['somark', 3, false],
      ['liteparse', 3, true],
    ]);
    expect(usage.facts.every((fact) => fact.eventSequence > 0)).toBe(true);
  });

  it('L1-B11-A-PARSE-002-F06 preserves the primary failure when LiteParse fallback itself fails', async () => {
    const { app } = application({
      async parse() {
        throw new S5OcrProviderError('provider', 503, [], true, false);
      },
      async fallback() {
        throw new Error('fallback unavailable');
      },
    });
    await expect(app.parse(input())).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_MODEL_FAILED',
          details: {
            provider: 'somark',
            errorKind: 'provider',
            status: 503,
            fallbackFailed: true,
          },
        },
      },
    });
  });

  it('L1-B11-A-PARSE-002-F07 schema retry exhaustion is bounded and does not loop indefinitely', async () => {
    let calls = 0;
    const { app } = application({
      async parse() {
        calls += 1;
        throw new S5OcrProviderError('contract', 200, [], false, true);
      },
    });
    await expect(
      app.parse(
        input({
          config: { ...config, fallbackProvider: 'none' },
        }),
      ),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID', retryable: false } },
    });
    expect(calls).toBe(2);
  });
});
