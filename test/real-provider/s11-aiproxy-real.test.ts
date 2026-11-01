import { describe, expect, it } from 'vitest';
import { AxiosS5HttpTransport } from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import { S5AiproxyHttpAdapter } from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import type { S5ModelInvocation } from '../../packages/service/src/modules/knowledge/application/s5-model-gateway.port';
import { probeCatalog } from '../../scripts/probe-aiproxy-catalog.mjs';
import {
  providerContext,
  requiredProviderEnv,
  safeHostHash,
  writeProviderEvidence,
} from './s11-real-helpers';

const pngDataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';

describe('TEST-X-S11-PROVIDER-REAL AIProxy', () => {
  it('catalog, five model roles, and non-zero usage are verified against the real endpoint', async () => {
    const env = { ...process.env, S11_SCOPE_PROFILE: 'knowledge-usability-v1' };
    const catalog = await probeCatalog(env);
    expect(catalog.status).toBe('READY');
    expect(catalog.requiresUserConfirmation).toBe(false);

    const baseUrl = requiredProviderEnv('AIPROXY_BASE_URL');
    const adapter = new S5AiproxyHttpAdapter({
      baseUrl,
      token: requiredProviderEnv('AIPROXY_API_TOKEN'),
      transport: new AxiosS5HttpTransport(),
    });
    const invoke = (invocation: S5ModelInvocation) =>
      adapter.invoke(invocation, {
        workspaceId: providerContext.workspaceId,
        requestId: providerContext.requestId,
        traceId: providerContext.traceId,
      });

    const llm = await invoke({
      kind: 'llm',
      modelId: requiredProviderEnv('S11_AIPROXY_LLM_MODEL'),
      messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
      maxOutputTokens: 8,
    });
    const embedding = await invoke({
      kind: 'embedding',
      modelId: requiredProviderEnv('S11_AIPROXY_EMBEDDING_MODEL'),
      input: [{ type: 'text', text: 'release hardening evidence' }],
      dimension: 1024,
    });
    const rerank = await invoke({
      kind: 'rerank',
      modelId: requiredProviderEnv('S11_AIPROXY_RERANK_MODEL'),
      query: 'release hardening',
      candidates: ['release evidence', 'unrelated material'],
    });
    const vlm = await invoke({
      kind: 'vlm',
      modelId: requiredProviderEnv('S11_AIPROXY_VLM_MODEL'),
      messages: [{ role: 'user', content: 'Describe the image briefly.' }],
      imageUrls: [pngDataUrl],
      maxOutputTokens: 32,
    });
    const visionEmbedding = await invoke({
      kind: 'embedding',
      modelId: requiredProviderEnv('S11_AIPROXY_VISION_EMBEDDING_MODEL'),
      input: [{ type: 'image_url', image_url: { url: pngDataUrl } }],
      dimension: 1024,
    });

    const results = { llm, embedding, rerank, vlm, visionEmbedding };
    for (const result of Object.values(results)) {
      expect(result.status).toBeGreaterThanOrEqual(200);
      expect(result.status).toBeLessThan(300);
      expect(result.quantity).toBeGreaterThan(0);
    }

    writeProviderEvidence('t02-aiproxy.json', {
      provider: 'aiproxy',
      status: 'REAL_VERIFIED',
      endpointHostHash: safeHostHash(baseUrl),
      catalogModelCount: catalog.modelCount,
      modelRoleCount: 5,
      modelIds: {
        llm: requiredProviderEnv('S11_AIPROXY_LLM_MODEL'),
        embedding: requiredProviderEnv('S11_AIPROXY_EMBEDDING_MODEL'),
        rerank: requiredProviderEnv('S11_AIPROXY_RERANK_MODEL'),
        vlm: requiredProviderEnv('S11_AIPROXY_VLM_MODEL'),
        visionEmbedding: requiredProviderEnv('S11_AIPROXY_VISION_EMBEDDING_MODEL'),
      },
      statuses: Object.fromEntries(
        Object.entries(results).map(([key, value]) => [key, value.status]),
      ),
      usage: Object.fromEntries(
        Object.entries(results).map(([key, value]) => [
          key,
          { quantity: value.quantity, ...value.usage },
        ]),
      ),
    });
  });
});
