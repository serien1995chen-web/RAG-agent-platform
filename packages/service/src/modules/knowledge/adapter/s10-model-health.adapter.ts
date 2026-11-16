import { createKnowledgeError } from '@kb/contracts';
import type { ModelCatalogItem, S5ModelType } from '../application/s5-model-ports';
import type { S5ModelGatewayPort, S5ModelInvocation } from '../application/s5-model-gateway.port';
import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';

const PROBE_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';

function probeFailure(context: TenantContext, reason: string) {
  return createKnowledgeError({
    code: 'KNOWLEDGE_MODEL_FAILED',
    requestId: context.requestId,
    traceId: context.traceId,
    details: { operation: 'model_health_probe', reason },
  });
}

function chatContent(data: unknown): string {
  if (typeof data !== 'object' || data === null) return '';
  const choices = (data as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
  const content = choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
}

function ttsAudio(data: unknown): { audio?: Uint8Array; audioUrl?: string } {
  if (data instanceof Uint8Array) return { audio: data };
  if (typeof data !== 'object' || data === null) return {};
  const record = data as { audio?: unknown; audioUrl?: unknown };
  return {
    ...(record.audio instanceof Uint8Array ? { audio: record.audio } : {}),
    ...(typeof record.audioUrl === 'string' ? { audioUrl: record.audioUrl } : {}),
  };
}

export class S10ModelHealthProbeAdapter {
  constructor(
    private readonly input: {
      gateway: S5ModelGatewayPort;
    },
  ) {}

  async probe(
    context: TenantContext,
    models: readonly ModelCatalogItem[],
  ): Promise<{ verifiedTypes: S5ModelType[] }> {
    const byType = new Map<S5ModelType, ModelCatalogItem>();
    for (const model of models) {
      if (model.authorized && !byType.has(model.type)) byType.set(model.type, model);
    }
    const required: S5ModelType[] = ['llm', 'embedding', 'rerank', 'vlm', 'stt', 'tts'];
    const missing = required.filter((type) => !byType.has(type));
    if (missing.length > 0) throw probeFailure(context, `missing_model_types:${missing.join(',')}`);

    const invoke = <T>(invocation: S5ModelInvocation) =>
      this.input.gateway.invoke<T>({
        ...invocation,
        workspaceId: context.workspaceId,
        knowledgeSpaceId: null,
        requestId: context.requestId,
        traceId: context.traceId,
        context,
        operation: 'status:model_health',
        resourceType: 'space',
        resourceId: context.workspaceId,
      });

    const llm = byType.get('llm')!;
    const embedding = byType.get('embedding')!;
    const rerank = byType.get('rerank')!;
    const vlm = byType.get('vlm')!;
    const stt = byType.get('stt')!;
    const tts = byType.get('tts')!;

    const llmResult = await invoke<{
      choices: Array<{ message: { content: string } }>;
    }>({
      kind: 'llm',
      modelId: llm.modelId,
      messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
      maxOutputTokens: 8,
    });
    if (!chatContent(llmResult.data)) throw probeFailure(context, 'llm_probe_empty');

    if (embedding.dimension === null) {
      throw probeFailure(context, 'embedding_dimension_missing');
    }
    const embeddingResult = await invoke<{
      data: Array<{ embedding: number[] }>;
    }>({
      kind: 'embedding',
      modelId: embedding.modelId,
      input: [{ type: 'text', text: 'model health probe' }],
      dimension: embedding.dimension,
    });
    const vector = embeddingResult.data.data[0]?.embedding;
    if (
      !vector ||
      vector.length !== embedding.dimension ||
      vector.some((value) => !Number.isFinite(value))
    ) {
      throw probeFailure(context, 'embedding_probe_invalid');
    }

    const rerankResult = await invoke<{ results: Array<{ index: number; score: number }> }>({
      kind: 'rerank',
      modelId: rerank.modelId,
      query: 'health check',
      candidates: ['model health probe', 'unrelated text'],
    });
    if (!rerankResult.data.results.some((result) => Number.isFinite(result.score))) {
      throw probeFailure(context, 'rerank_probe_invalid');
    }

    const vlmResult = await invoke<{
      choices: Array<{ message: { content: string } }>;
    }>({
      kind: 'vlm',
      modelId: vlm.modelId,
      messages: [{ role: 'user', content: 'Return one short word for this image.' }],
      imageUrls: [PROBE_IMAGE],
      maxOutputTokens: 16,
    });
    if (!chatContent(vlmResult.data)) throw probeFailure(context, 'vlm_probe_empty');

    const ttsResult = await invoke<unknown>({
      kind: 'tts',
      modelId: tts.modelId,
      text: '健康检查',
    });
    const audio = ttsAudio(ttsResult.data);
    if (!audio.audio && !audio.audioUrl) {
      throw probeFailure(context, 'tts_probe_empty');
    }

    const sttResult = await invoke<{ text: string }>({
      kind: 'stt',
      modelId: stt.modelId,
      ...(audio.audioUrl
        ? { audioUrl: audio.audioUrl, mimeType: 'audio/mpeg' }
        : { audio: audio.audio!, mimeType: 'audio/mpeg' }),
    });
    if (!sttResult.data.text.trim()) throw probeFailure(context, 'stt_probe_empty');

    return { verifiedTypes: required };
  }
}
