import { describe, expect, it } from 'vitest';
import {
  AxiosS5HttpTransport,
  S5AiproxyHttpAdapter,
} from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import type { S5ModelInvocation } from '../../packages/service/src/modules/knowledge/application/s5-model-gateway.port';
import { loadS5AiproxyConfig } from '../../packages/service/src/shared/config/s5-aiproxy-config';

const REQUIRED_FIELDS = [
  'AIPROXY_BASE_URL',
  'AIPROXY_API_TOKEN',
  'S11_AIPROXY_LLM_MODEL',
  'S11_AIPROXY_EMBEDDING_MODEL',
  'S11_AIPROXY_RERANK_MODEL',
  'S11_AIPROXY_VLM_MODEL',
  'S11_EVIDENCE_DIR',
  'CANDIDATE_SHA',
] as const;

const providerContext = {
  workspaceId: 'ws_b15_real_provider',
  requestId: 'req_b15_real_provider',
  traceId: 'trace_b15_real_provider',
};

const pngDataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';

function required(name: (typeof REQUIRED_FIELDS)[number]): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`B15_PROVIDER_REAL_BLOCKED: missing ${name}`);
  return value;
}

describe('L1-B15-B real Provider handoff', () => {
  it('L1-B15-B-MODEL-003/004/006-P01..04 verifies LLM, embedding, rerank and VLM roles when A supplies credentials', async () => {
    const missing = REQUIRED_FIELDS.filter((name) => !process.env[name]?.trim());
    expect(missing, `B15_PROVIDER_REAL_BLOCKED: missing ${missing.join(', ')}`).toEqual([]);

    const config = loadS5AiproxyConfig(process.env);
    const adapter = new S5AiproxyHttpAdapter({
      baseUrl: required('AIPROXY_BASE_URL'),
      token: required('AIPROXY_API_TOKEN'),
      transport: new AxiosS5HttpTransport(),
      ...(config.providerOnly ? { providerOnly: config.providerOnly } : {}),
      rerankProtocol: config.rerankProtocol,
    });
    const invoke = (request: S5ModelInvocation) => adapter.invoke(request, providerContext);

    const llm = await invoke({
      kind: 'llm',
      modelId: required('S11_AIPROXY_LLM_MODEL'),
      messages: [{ role: 'user', content: 'Return exactly OK.' }],
      maxOutputTokens: 8,
    });
    const embedding = await invoke({
      kind: 'embedding',
      modelId: required('S11_AIPROXY_EMBEDDING_MODEL'),
      input: [{ type: 'text', text: 'B15 model gateway validation' }],
      dimension: 1024,
    });
    const rerank = await invoke({
      kind: 'rerank',
      modelId: required('S11_AIPROXY_RERANK_MODEL'),
      query: 'refund policy',
      candidates: ['refunds take five business days', 'shipping address'],
    });
    const vlm = await invoke({
      kind: 'vlm',
      modelId: required('S11_AIPROXY_VLM_MODEL'),
      messages: [{ role: 'user', content: 'Describe this image in one short sentence.' }],
      imageUrls: [pngDataUrl],
      maxOutputTokens: 32,
    });

    for (const result of [llm, embedding, rerank, vlm]) {
      expect(result.status).toBeGreaterThanOrEqual(200);
      expect(result.status).toBeLessThan(300);
      expect(result.quantity).toBeGreaterThan(0);
    }
  }, 180_000);
});
