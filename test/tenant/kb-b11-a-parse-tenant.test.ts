import { describe, expect, it } from 'vitest';
import { S5OcrApplication } from '../../packages/service/src/modules/knowledge/application/s5-ocr.application';
import type {
  S5OcrProviderConfig,
  S5ProviderUsageFact,
  S5ProviderUsageRecorderPort,
} from '../../packages/service/src/modules/knowledge/application/s5-ocr-ports';
import type { TenantContext } from '../../packages/service/src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_b11_tenant',
  memberId: 'mem_b11_tenant',
  requestId: 'req-b11-tenant',
  traceId: 'trace-b11-tenant',
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

describe('L1-B11-A PARSE permission and tenant boundaries', () => {
  it('L1-B11-A-PARSE-002-A01 fails closed before provider, asset or usage side effects on a tenant mismatch', async () => {
    let providerCalls = 0;
    let guardCalls = 0;
    const usage = new Usage();
    const application = new S5OcrApplication({
      provider: {
        async parse() {
          providerCalls += 1;
          throw new Error('must not call');
        },
      },
      usage,
      remoteAssets: {
        async fetch() {
          throw new Error('must not fetch');
        },
      },
      assetSink: {
        async putImage() {
          throw new Error('must not write');
        },
      },
      sourceGuard: {
        async assertSource() {
          guardCalls += 1;
          throw new Error('guard mismatch');
        },
      },
    });

    await expect(
      application.parse({
        workspaceId: 'ws_other_b11',
        knowledgeSpaceId: 'space-b11',
        sourceId: 'source-b11',
        sourceVersion: 1,
        bytes: Buffer.from('%PDF-1.4'),
        fileName: 'b11.pdf',
        mimeType: 'application/pdf',
        config,
        timeoutMs: 10_000,
        requestId: context.requestId,
        traceId: context.traceId,
        context,
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_FORBIDDEN' } } });
    expect(providerCalls).toBe(0);
    expect(guardCalls).toBe(0);
    expect(usage.facts).toEqual([]);
  });

  it('L1-B11-A-PARSE-002-A02 hides a missing or cross-tenant Source before any Provider request', async () => {
    let providerCalls = 0;
    const application = new S5OcrApplication({
      provider: {
        async parse() {
          providerCalls += 1;
          throw new Error('must not call');
        },
      },
      usage: new Usage(),
      remoteAssets: {
        async fetch() {
          throw new Error('must not fetch');
        },
      },
      assetSink: {
        async putImage() {
          throw new Error('must not write');
        },
      },
      sourceGuard: {
        async assertSource() {
          throw Object.assign(new Error('hidden'), {
            problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } },
          });
        },
      },
    });
    await expect(
      application.parse({
        workspaceId: context.workspaceId,
        knowledgeSpaceId: 'space-hidden',
        sourceId: 'source-hidden',
        sourceVersion: 1,
        bytes: Buffer.from('%PDF-1.4'),
        fileName: 'b11.pdf',
        mimeType: 'application/pdf',
        config,
        timeoutMs: 10_000,
        requestId: context.requestId,
        traceId: context.traceId,
        context,
      }),
    ).rejects.toMatchObject({ problem: { error: { code: 'KNOWLEDGE_NOT_FOUND' } } });
    expect(providerCalls).toBe(0);
  });
});
