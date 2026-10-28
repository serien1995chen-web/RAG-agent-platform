import { createKnowledgeError, type KnowledgeErrorCode } from '@kb/contracts';
import type { ModelCatalogItem, ModelCatalogPort, S5ModelType } from './s5-model-ports';
import type {
  S5GatewayResult,
  S5GatewayUsageFact,
  S5EmbeddingInputItem,
  S5KeyedLimiterPort,
  S5ModelGatewayPort,
  S5ModelGatewayRequest,
  S5ModelInvocation,
  S5ModelInvocationAdapterPort,
  S5ModelTransportError,
  S5UsageRecorderPort,
  S5UsageUnit,
} from './s5-model-gateway.port';
import { S5ModelTransportError as TransportError } from './s5-model-gateway.port';

const MAX_INPUT_TOKENS = 32_000;
const MAX_OUTPUT_TOKENS = 4_096;
const MAX_EMBEDDING_TEXTS = 64;
const MAX_EMBEDDING_TOKENS = 8_192;
const MAX_RERANK_CANDIDATES = 100;
const MAX_RERANK_TOKENS = 16_000;
const MAX_VLM_IMAGES = 10;
const MAX_STT_BYTES = 100 * 1024 * 1024;
const MAX_TTS_CHARS = 5_000;

class PassthroughLimiter implements S5KeyedLimiterPort {
  run<T>(_key: string, work: () => Promise<T>): Promise<T> {
    return work();
  }
}

function modelKind(invocation: S5ModelInvocation): S5ModelType {
  return invocation.kind;
}

function usageUnit(kind: S5ModelType): S5UsageUnit {
  if (kind === 'llm' || kind === 'vlm' || kind === 'embedding' || kind === 'rerank') {
    return 'token';
  }
  if (kind === 'stt' || kind === 'tts') return 'second';
  return 'request';
}

function approximateTokens(text: string | undefined): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil([...text].length / 4));
}

export function embeddingInputItems(invocation: {
  input?: readonly S5EmbeddingInputItem[];
  texts?: readonly string[];
}): S5EmbeddingInputItem[] {
  if (invocation.input !== undefined) return [...invocation.input];
  return (invocation.texts ?? []).map((text) => ({ type: 'text', text }));
}

function validateBudget(invocation: S5ModelInvocation, requestId: string, traceId: string): void {
  const fail = (details: Record<string, unknown>) => {
    throw createKnowledgeError({
      code: 'KNOWLEDGE_VALIDATION_FAILED',
      requestId,
      traceId,
      details,
    });
  };
  switch (invocation.kind) {
    case 'llm':
      if (approximateTokens(JSON.stringify(invocation.messages)) > MAX_INPUT_TOKENS) {
        fail({ field: 'messages', maxTokens: MAX_INPUT_TOKENS });
      }
      if (
        !Number.isInteger(invocation.maxOutputTokens) ||
        invocation.maxOutputTokens < 1 ||
        invocation.maxOutputTokens > MAX_OUTPUT_TOKENS
      ) {
        fail({ field: 'maxOutputTokens', min: 1, max: MAX_OUTPUT_TOKENS });
      }
      break;
    case 'vlm':
      if (invocation.imageUrls.length > MAX_VLM_IMAGES) {
        fail({ field: 'imageUrls', max: MAX_VLM_IMAGES });
      }
      if (
        invocation.maxOutputTokens !== undefined &&
        (!Number.isInteger(invocation.maxOutputTokens) ||
          invocation.maxOutputTokens < 1 ||
          invocation.maxOutputTokens > MAX_OUTPUT_TOKENS)
      ) {
        fail({ field: 'maxOutputTokens', min: 1, max: MAX_OUTPUT_TOKENS });
      }
      break;
    case 'embedding': {
      const items = embeddingInputItems(invocation);
      if (items.length < 1 || items.length > MAX_EMBEDDING_TEXTS) {
        fail({ field: 'input', min: 1, max: MAX_EMBEDDING_TEXTS });
      }
      if (
        items.some((item) =>
          item.type === 'text'
            ? item.text.trim().length === 0
            : !/^https?:\/\//i.test(item.image_url.url),
        )
      ) {
        fail({ field: 'input', reason: 'invalid_embedding_input_item' });
      }
      if (
        items.reduce(
          (sum, item) => sum + (item.type === 'text' ? approximateTokens(item.text) : 0),
          0,
        ) > MAX_EMBEDDING_TOKENS
      ) {
        fail({ field: 'input', maxTokens: MAX_EMBEDDING_TOKENS });
      }
      break;
    }
    case 'rerank':
      if (
        invocation.candidates.length < 1 ||
        invocation.candidates.length > MAX_RERANK_CANDIDATES
      ) {
        fail({ field: 'candidates', min: 1, max: MAX_RERANK_CANDIDATES });
      }
      if (
        approximateTokens(invocation.query) +
          approximateTokens(JSON.stringify(invocation.candidates)) >
        MAX_RERANK_TOKENS
      ) {
        fail({ field: 'candidates', maxTokens: MAX_RERANK_TOKENS });
      }
      break;
    case 'stt':
      if (invocation.audio.byteLength > MAX_STT_BYTES) {
        fail({ field: 'audio', maxBytes: MAX_STT_BYTES });
      }
      break;
    case 'tts':
      if ([...invocation.text].length > MAX_TTS_CHARS) {
        fail({ field: 'text', maxCharacters: MAX_TTS_CHARS });
      }
      break;
  }
}

function resultTypeOk(model: ModelCatalogItem, kind: S5ModelType): boolean {
  return model.authorized && model.type === kind;
}

function transportCode(kind: S5ModelTransportError['kind']): KnowledgeErrorCode {
  if (kind === 'auth') return 'KNOWLEDGE_MODEL_FAILED';
  if (kind === 'rate_limit') return 'KNOWLEDGE_RATE_LIMITED';
  if (kind === 'timeout') return 'KNOWLEDGE_DEPENDENCY_TIMEOUT';
  if (kind === 'contract') return 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID';
  if (kind === 'validation') return 'KNOWLEDGE_VALIDATION_FAILED';
  return 'KNOWLEDGE_MODEL_FAILED';
}

function transportRetryable(kind: S5ModelTransportError['kind']): boolean {
  return kind === 'rate_limit' || kind === 'timeout' || kind === 'provider';
}

function transportFailure(
  error: S5ModelTransportError,
  request: S5ModelGatewayRequest,
  details: Record<string, unknown> = {},
) {
  return createKnowledgeError({
    code: transportCode(error.kind),
    requestId: request.requestId,
    traceId: request.traceId,
    retryable: transportRetryable(error.kind),
    details: {
      modelId: request.modelId,
      actualModelId: String(details.actualModelId ?? request.modelId),
      upstreamStatus: error.status,
      errorKind: error.kind,
      ...details,
    },
  });
}

export class S5ModelGateway implements S5ModelGatewayPort {
  constructor(
    private readonly input: {
      catalog: ModelCatalogPort;
      adapter: S5ModelInvocationAdapterPort;
      usage: S5UsageRecorderPort;
      limiter?: S5KeyedLimiterPort;
      maxAttempts?: number;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  private async selectModels(
    request: S5ModelGatewayRequest,
  ): Promise<{ primary: ModelCatalogItem; fallbacks: ModelCatalogItem[] }> {
    const models = await this.input.catalog.listModels({
      workspaceId: request.workspaceId,
      requestId: request.requestId,
      traceId: request.traceId,
    });
    const kind = modelKind(request);
    const primary = models.find(
      (model) => model.modelId === request.modelId && resultTypeOk(model, kind),
    );
    if (!primary) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: request.requestId,
        traceId: request.traceId,
        details: {
          field: 'modelId',
          modelId: request.modelId,
          reason: 'not_authorized_for_type',
        },
      });
    }
    const fallbacks = (request.fallbackModelIds ?? [])
      .map((modelId) => models.find((model) => model.modelId === modelId))
      .filter((model): model is ModelCatalogItem =>
        model !== undefined ? resultTypeOk(model, kind) : false,
      )
      .filter((model) => model.modelId !== primary.modelId);
    return { primary, fallbacks };
  }

  async invoke<T = unknown>(request: S5ModelGatewayRequest): Promise<S5GatewayResult<T>> {
    if (request.context.workspaceId !== request.workspaceId) {
      throw createKnowledgeError({
        code: 'KNOWLEDGE_VALIDATION_FAILED',
        requestId: request.requestId,
        traceId: request.traceId,
        details: { field: 'workspaceId', reason: 'tenant_mismatch' },
      });
    }
    validateBudget(request, request.requestId, request.traceId);
    const limiter = this.input.limiter ?? new PassthroughLimiter();
    return limiter.run(request.workspaceId, async () => {
      const { primary, fallbacks } = await this.selectModels(request);
      const candidates = [primary, ...fallbacks];
      const maxAttempts = Math.max(1, Math.min(this.input.maxAttempts ?? 3, 3));
      let candidateIndex = 0;
      let fallbackUsed = false;
      let lastError: S5ModelTransportError | null = null;
      let inputTokens = 0;
      let outputTokens = 0;
      let quantity = 0;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const candidate = candidates[Math.min(candidateIndex, candidates.length - 1)]!;
        const currentInvocation = {
          ...request,
          modelId: candidate.modelId,
        } as S5ModelInvocation;
        try {
          const parsed = await this.input.adapter.invoke<unknown>(currentInvocation, {
            workspaceId: request.workspaceId,
            requestId: request.requestId,
            traceId: request.traceId,
          });
          await this.recordUsage(
            request,
            candidate,
            attempt,
            parsed.quantity,
            parsed.status,
            fallbackUsed,
          );
          inputTokens += parsed.usage.inputTokens;
          outputTokens += parsed.usage.outputTokens;
          quantity = parsed.quantity;
          return {
            data: parsed.data as T,
            actualModelId: candidate.modelId,
            attempts: attempt,
            fallbackUsed,
            degraded: candidate.modelId !== request.modelId,
            usage: { inputTokens, outputTokens, quantity },
          };
        } catch (error) {
          if (!(error instanceof TransportError)) throw error;
          lastError = error;
          await this.recordUsage(request, candidate, attempt, 0, error.status, fallbackUsed);
          if (!transportRetryable(error.kind)) {
            throw transportFailure(error, request, { actualModelId: candidate.modelId });
          }
          if (attempt >= maxAttempts) break;
          if (candidateIndex + 1 < candidates.length) {
            candidateIndex += 1;
            fallbackUsed = true;
          }
          const retryDelay =
            error.retryAfterMs ?? Math.min(5_000, 250 * 2 ** Math.min(attempt - 1, 5));
          await (this.input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
            retryDelay,
          );
        }
      }
      const finalError =
        lastError ?? new TransportError('provider', null, null, 'attempts_exhausted_without_error');
      throw transportFailure(finalError, request, {
        actualModelId:
          candidates[Math.min(candidateIndex, candidates.length - 1)]?.modelId ?? request.modelId,
        attempts: maxAttempts,
        fallbackUsed,
        reason: 'attempts_exhausted',
      });
    });
  }

  private async recordUsage(
    request: S5ModelGatewayRequest,
    candidate: ModelCatalogItem,
    attempt: number,
    quantity: number,
    status: number | null,
    fallbackUsed: boolean,
  ): Promise<void> {
    const fact: S5GatewayUsageFact = {
      workspaceId: request.workspaceId,
      knowledgeSpaceId: request.knowledgeSpaceId,
      operation: request.operation ?? request.kind,
      requestId: request.requestId,
      traceId: request.traceId,
      modelId: candidate.modelId,
      kind: request.kind,
      attempt,
      eventSequence: attempt,
      quantity: Math.max(0, quantity),
      unit: usageUnit(request.kind),
      status,
      fallbackUsed,
      provider: 'aiproxy',
      resourceType: request.resourceType ?? 'space',
      resourceId: request.resourceId ?? request.knowledgeSpaceId ?? request.workspaceId,
    };
    await this.input.usage.recordInvocationUsage(fact, request.context);
  }
}

export function createS5ModelGateway(input: {
  catalog: ModelCatalogPort;
  adapter: S5ModelInvocationAdapterPort;
  usage: S5UsageRecorderPort;
  limiter: S5KeyedLimiterPort;
  sleep?: (ms: number) => Promise<void>;
}): S5ModelGateway {
  return new S5ModelGateway(input);
}
