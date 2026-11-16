import { describe, expect, it } from 'vitest';
import { S10StatusProbesAdapter } from '../../src/modules/knowledge/adapter/s10-status-probes.adapter';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_b15_model_probe',
  memberId: 'mem_b15_model_probe',
  requestId: 'req_b15_model_probe',
  traceId: 'trace_b15_model_probe',
  scopes: ['knowledge:admin'],
};

describe('L1 B15 A model health probe', () => {
  it('L1-B15-A-MODEL-001-Q01 catalog listing alone is not a REAL_VERIFIED model probe', async () => {
    let catalogCalls = 0;
    const adapter = new S10StatusProbesAdapter({
      config: {
        externalModes: { model: 'real' },
        s3: { provider: 'minio' },
        s10: {
          apiKeyHmacConfigured: true,
          quota: { requestsPerMinute: 30 },
        },
      } as never,
      connection: {} as never,
      queues: new Map(),
      readiness: async () => ({
        status: 200,
        body: {
          checks: ['mongo', 'redis', 'postgres', 's3'].map((name) => ({
            name,
            status: 'ok',
            latencyMs: 1,
          })),
        },
      }),
      models: {
        async listModels() {
          catalogCalls += 1;
          return [
            {
              modelId: 'llm-real',
              displayName: 'LLM',
              type: 'llm',
              capabilities: ['chat'],
              dimension: null,
              authorized: true,
            },
            {
              modelId: 'embedding-real',
              displayName: 'Embedding',
              type: 'embedding',
              capabilities: ['text-embedding', 'dimension:1024'],
              dimension: 1024,
              authorized: true,
            },
            {
              modelId: 'rerank-real',
              displayName: 'Rerank',
              type: 'rerank',
              capabilities: ['rerank'],
              dimension: null,
              authorized: true,
            },
            {
              modelId: 'vlm-real',
              displayName: 'VLM',
              type: 'vlm',
              capabilities: ['vision'],
              dimension: null,
              authorized: true,
            },
            {
              modelId: 'stt-real',
              displayName: 'STT',
              type: 'stt',
              capabilities: ['speech-to-text'],
              dimension: null,
              authorized: true,
            },
            {
              modelId: 'tts-real',
              displayName: 'TTS',
              type: 'tts',
              capabilities: ['text-to-speech'],
              dimension: null,
              authorized: true,
            },
          ];
        },
      },
      connectors: {
        async list() {
          return [];
        },
      },
    });

    const view = await adapter.probe(context);
    expect(catalogCalls).toBe(1);
    expect(view.modelProbe.verificationStatus).not.toBe('REAL_VERIFIED');
  });
});
