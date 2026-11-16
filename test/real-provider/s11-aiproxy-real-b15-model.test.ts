import { describe, expect, it } from 'vitest';
import { S5AiproxyCatalogAdapter } from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-catalog.adapter';
import { AxiosS5HttpTransport } from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import { loadS5AiproxyConfig } from '../../packages/service/src/shared/config/s5-aiproxy-config';
import {
  providerContext,
  requiredProviderEnv,
  safeHostHash,
  writeProviderEvidence,
} from './s11-real-helpers';

describe('L1 B15 A TokenDance model catalog validation', () => {
  it('L1-B15-A-MODEL-001-P01 已批准六类模型通过真实 catalog 并保留能力与维度', async () => {
    const env = { ...process.env };
    const config = loadS5AiproxyConfig(env);
    const catalog = new S5AiproxyCatalogAdapter({
      config,
      transport: new AxiosS5HttpTransport(),
      env,
    });
    const models = await catalog.listModels({
      workspaceId: providerContext.workspaceId,
      requestId: providerContext.requestId,
      traceId: providerContext.traceId,
    });

    const approved = {
      llm: requiredProviderEnv('S11_AIPROXY_LLM_MODEL'),
      embedding: requiredProviderEnv('S11_AIPROXY_EMBEDDING_MODEL'),
      rerank: requiredProviderEnv('S11_AIPROXY_RERANK_MODEL'),
      vlm: requiredProviderEnv('S11_AIPROXY_VLM_MODEL'),
      stt: requiredProviderEnv('S11_AIPROXY_STT_MODEL'),
      tts: requiredProviderEnv('S11_AIPROXY_TTS_MODEL'),
    };
    const byId = new Map(models.map((model) => [model.modelId, model]));
    for (const [type, modelId] of Object.entries(approved)) {
      expect(byId.get(modelId)).toMatchObject({
        modelId,
        type,
        authorized: true,
      });
    }
    expect(byId.get(approved.embedding)).toMatchObject({
      dimension: 1024,
      capabilities: expect.arrayContaining(['text-embedding', 'caption-embedding']),
    });
    expect(byId.get(approved.stt)?.capabilities).toContain('speech-to-text');
    expect(byId.get(approved.tts)?.capabilities).toContain('text-to-speech');
    expect(new Set(models.map((model) => model.type))).toEqual(
      new Set(['llm', 'embedding', 'rerank', 'vlm', 'stt', 'tts']),
    );

    const serialized = JSON.stringify(models);
    expect(serialized).not.toContain(requiredProviderEnv('AIPROXY_API_TOKEN'));
    writeProviderEvidence('t02-b15-model-catalog.json', {
      subcase: 'L1-B15-A-MODEL-001-P01',
      provider: 'aiproxy',
      endpointHostHash: safeHostHash(requiredProviderEnv('AIPROXY_BASE_URL')),
      approvedModelIds: approved,
      modelTypes: [...new Set(models.map((model) => model.type))].sort(),
      embedding: byId.get(approved.embedding),
      modelCount: models.length,
    });
  });
});
