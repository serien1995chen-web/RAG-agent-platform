import { z } from 'zod';
import { createKnowledgeError } from '@kb/contracts';
import {
  S5_MODEL_TYPES,
  type ModelCatalogItem,
  type ModelCatalogPort,
} from '../application/s5-model-ports';
import { resolveSecretRef } from '../../../shared/config/secret-ref';
import type { S5AiproxyConfig } from '../../../shared/config/s5-aiproxy-config';
import { S5ModelTransportError } from '../application/s5-model-gateway.port';
import { S5AiproxyCatalogEnvelopeSchema, normalizeCatalog } from './s5-model-catalog.schema';
import { joinAiproxyUrl, type S5HttpTransportPort } from './s5-aiproxy-http.adapter';

const BareCatalogEnvelopeSchema = z
  .object({
    data: z.array(z.object({ id: z.string().min(1).max(256) }).passthrough()),
  })
  .passthrough();

const ModelProfileSchema = z
  .object({
    models: z.array(
      z
        .object({
          id: z.string().min(1).max(256),
          type: z.enum(S5_MODEL_TYPES),
          capabilities: z.array(z.string().min(1).max(128)).min(1),
          dimension: z.number().int().nullable().optional(),
        })
        .strict(),
    ),
  })
  .strict();

type ModelProfileEntry = z.infer<typeof ModelProfileSchema>['models'][number];

function modelProfile(env: Readonly<Record<string, string | undefined>>) {
  const raw = env.AIPROXY_MODEL_PROFILE_JSON?.trim();
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = ModelProfileSchema.safeParse(value);
  if (!parsed.success) return null;
  const profile = new Map<string, ModelProfileEntry>();
  for (const entry of parsed.data.models) {
    if (profile.has(entry.id)) return null;
    profile.set(entry.id, entry);
  }
  return profile;
}

function mergeCatalogWithProfile(
  payload: unknown,
  profile: ReadonlyMap<string, ModelProfileEntry>,
) {
  const bare = BareCatalogEnvelopeSchema.safeParse(payload);
  if (!bare.success) return null;
  return {
    data: bare.data.data.flatMap((item) => {
      const configured = profile.get(item.id);
      if (!configured) return [];
      return [
        {
          ...item,
          type: configured.type,
          capabilities: configured.capabilities,
          ...(typeof configured.dimension === 'number' ? { dimension: configured.dimension } : {}),
        },
      ];
    }),
  };
}

function catalogError(
  code:
    | 'KNOWLEDGE_MODEL_FAILED'
    | 'KNOWLEDGE_RATE_LIMITED'
    | 'KNOWLEDGE_DEPENDENCY_TIMEOUT'
    | 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID',
  requestId: string,
  traceId: string,
  status: number | null,
) {
  return createKnowledgeError({
    code,
    requestId,
    traceId,
    retryable: code !== 'KNOWLEDGE_MODEL_FAILED' || status === 503,
    details: { operation: 'model_catalog', upstreamStatus: status },
  });
}

export class S5AiproxyCatalogAdapter implements ModelCatalogPort {
  private readonly token: string;
  private readonly env: Readonly<Record<string, string | undefined>>;

  constructor(
    private readonly input: {
      config: S5AiproxyConfig;
      transport: S5HttpTransportPort;
      env?: Readonly<Record<string, string | undefined>>;
    },
  ) {
    this.token = resolveSecretRef(input.config.apiTokenRef, input.env ?? {});
    this.env = input.env ?? {};
  }

  async listModels(input: {
    workspaceId: string;
    requestId: string;
    traceId: string;
  }): Promise<ModelCatalogItem[]> {
    let response;
    try {
      response = await this.input.transport.request({
        method: 'GET',
        url: joinAiproxyUrl(this.input.config.baseUrl, '/v1/models'),
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          'X-Workspace-Id': input.workspaceId,
          'X-Request-Id': input.requestId,
          'X-Trace-Id': input.traceId,
        },
        timeoutMs: 5_000,
      });
    } catch (error) {
      if (error instanceof S5ModelTransportError && error.kind === 'timeout') {
        throw catalogError('KNOWLEDGE_DEPENDENCY_TIMEOUT', input.requestId, input.traceId, null);
      }
      if (error instanceof S5ModelTransportError) {
        throw catalogError('KNOWLEDGE_MODEL_FAILED', input.requestId, input.traceId, null);
      }
      throw error;
    }
    if (response.status === 401 || response.status === 403) {
      throw catalogError('KNOWLEDGE_MODEL_FAILED', input.requestId, input.traceId, response.status);
    }
    if (response.status === 429) {
      throw catalogError('KNOWLEDGE_RATE_LIMITED', input.requestId, input.traceId, response.status);
    }
    if (response.status >= 500) {
      throw catalogError('KNOWLEDGE_MODEL_FAILED', input.requestId, input.traceId, response.status);
    }
    if (response.status < 200 || response.status >= 300) {
      throw catalogError(
        'KNOWLEDGE_PROVIDER_CONTRACT_INVALID',
        input.requestId,
        input.traceId,
        response.status,
      );
    }
    const profile = modelProfile(this.env);
    if (profile && this.env.S11_AIPROXY_MODEL_MAPPING_APPROVED !== 'true') {
      throw catalogError(
        'KNOWLEDGE_PROVIDER_CONTRACT_INVALID',
        input.requestId,
        input.traceId,
        response.status,
      );
    }
    const catalogPayload = profile
      ? mergeCatalogWithProfile(response.data, profile)
      : response.data;
    const parsed = S5AiproxyCatalogEnvelopeSchema.safeParse(catalogPayload);
    if (!parsed.success) {
      throw catalogError(
        'KNOWLEDGE_PROVIDER_CONTRACT_INVALID',
        input.requestId,
        input.traceId,
        response.status,
      );
    }
    try {
      return normalizeCatalog(parsed.data);
    } catch {
      throw catalogError(
        'KNOWLEDGE_PROVIDER_CONTRACT_INVALID',
        input.requestId,
        input.traceId,
        response.status,
      );
    }
  }
}

export class S5MockModelCatalog implements ModelCatalogPort {
  async listModels(): Promise<ModelCatalogItem[]> {
    const models: ModelCatalogItem[] = [
      {
        modelId: 'mock-llm-general',
        displayName: 'Mock general LLM',
        type: 'llm',
        capabilities: ['chat', 'structured-output'],
        dimension: null,
        authorized: true,
      },
      ...([768, 1024, 1536, 3072] as const).map((dimension) => ({
        modelId: `mock-embedding-${dimension}`,
        displayName: `Mock embedding ${dimension}`,
        type: 'embedding' as const,
        capabilities: ['text-embedding', 'vision', `dimension:${dimension}`],
        dimension,
        authorized: true,
      })),
      {
        modelId: 'mock-rerank',
        displayName: 'Mock rerank',
        type: 'rerank',
        capabilities: ['rerank'],
        dimension: null,
        authorized: true,
      },
      {
        modelId: 'mock-vlm',
        displayName: 'Mock vision model',
        type: 'vlm',
        capabilities: ['vision', 'structured-output'],
        dimension: null,
        authorized: true,
      },
      {
        modelId: 'mock-stt',
        displayName: 'Mock speech recognition',
        type: 'stt',
        capabilities: ['speech-to-text'],
        dimension: null,
        authorized: true,
      },
      {
        modelId: 'mock-tts',
        displayName: 'Mock speech synthesis',
        type: 'tts',
        capabilities: ['text-to-speech'],
        dimension: null,
        authorized: true,
      },
    ];
    return models.sort((left, right) => left.modelId.localeCompare(right.modelId));
  }
}
