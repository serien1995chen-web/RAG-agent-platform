import { describe, expect, it } from 'vitest';
import { AxiosS5HttpTransport } from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import { S5AiproxyHttpAdapter } from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import type { S5ModelInvocation } from '../../packages/service/src/modules/knowledge/application/s5-model-gateway.port';
import { loadS5AiproxyConfig } from '../../packages/service/src/shared/config/s5-aiproxy-config';
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
  it('verifies every role with an explicit caption-only embedding fallback', async () => {
    const env = { ...process.env, S11_SCOPE_PROFILE: 'knowledge-usability-v1' };
    const catalog = await probeCatalog(env);
    expect(catalog.status).toBe('READY');
    expect(catalog.modelCount).toBeGreaterThan(0);

    const baseUrl = requiredProviderEnv('AIPROXY_BASE_URL');
    const aiproxyConfig = loadS5AiproxyConfig(env);
    const adapter = new S5AiproxyHttpAdapter({
      baseUrl,
      token: requiredProviderEnv('AIPROXY_API_TOKEN'),
      transport: new AxiosS5HttpTransport(),
      ...(aiproxyConfig.providerOnly ? { providerOnly: aiproxyConfig.providerOnly } : {}),
      rerankProtocol: aiproxyConfig.rerankProtocol,
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
    const visionEmbeddingModelId = requiredProviderEnv('S11_AIPROXY_VISION_EMBEDDING_MODEL');
    const visionModelAvailable = catalog.models.some(
      (model) => model.id === visionEmbeddingModelId,
    );
    const visionMapping = catalog.mappings.find((mapping) => mapping.kind === 'vision-embedding');
    const visionEmbeddingMode = visionMapping?.mode;
    const visionEmbedding = visionModelAvailable
      ? await invoke({
          kind: 'embedding',
          modelId: visionEmbeddingModelId,
          input:
            visionEmbeddingMode === 'caption-embedding'
              ? [{ type: 'text', text: 'A one pixel knowledge image.' }]
              : [{ type: 'image_url', image_url: { url: pngDataUrl } }],
          dimension: 1024,
        })
      : null;

    const results = { llm, embedding, rerank, vlm };
    for (const result of Object.values(results)) {
      expect(result.status).toBeGreaterThanOrEqual(200);
      expect(result.status).toBeLessThan(300);
      expect(result.quantity).toBeGreaterThan(0);
    }
    if (visionEmbedding) {
      expect(visionEmbedding.status).toBeGreaterThanOrEqual(200);
      expect(visionEmbedding.status).toBeLessThan(300);
      expect(visionEmbedding.quantity).toBeGreaterThan(0);
    }

    writeProviderEvidence('t02-aiproxy.json', {
      provider: 'aiproxy',
      status: visionEmbedding ? 'REAL_VERIFIED' : 'SCOPED_BLOCKED',
      endpointHostHash: safeHostHash(baseUrl),
      catalogModelCount: catalog.modelCount,
      modelRoleCount: visionEmbedding ? 5 : 4,
      modelIds: {
        llm: requiredProviderEnv('S11_AIPROXY_LLM_MODEL'),
        embedding: requiredProviderEnv('S11_AIPROXY_EMBEDDING_MODEL'),
        rerank: requiredProviderEnv('S11_AIPROXY_RERANK_MODEL'),
        vlm: requiredProviderEnv('S11_AIPROXY_VLM_MODEL'),
        visionEmbedding: visionEmbeddingModelId,
      },
      visionEmbeddingMode,
      statuses: Object.fromEntries([
        ...Object.entries(results).map(([key, value]) => [key, value.status]),
        ...(visionEmbedding ? [['visionEmbedding', visionEmbedding.status]] : []),
      ]),
      usage: Object.fromEntries([
        ...Object.entries(results).map(([key, value]) => [
          key,
          { quantity: value.quantity, ...value.usage },
        ]),
        ...(visionEmbedding
          ? [['visionEmbedding', { quantity: visionEmbedding.quantity, ...visionEmbedding.usage }]]
          : []),
      ]),
      blockers: visionEmbedding
        ? []
        : ['S11_AIPROXY_VISION_EMBEDDING_MODEL is not approved by the model profile'],
    });
  });
});
