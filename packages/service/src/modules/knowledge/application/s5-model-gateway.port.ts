import type { TenantContext } from '../../../shared/persistence/knowledge/tenant';
import { S5_MODEL_TYPES, type S5ModelType, type S5VectorDimension } from './s5-model-ports';

export { S5_MODEL_TYPES };
export type { S5ModelType, S5VectorDimension };

export type S5EmbeddingInputItem =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type S5ModelInvocation =
  | {
      kind: 'llm';
      modelId: string;
      messages: unknown[];
      maxOutputTokens: number;
    }
  | {
      kind: 'vlm';
      modelId: string;
      messages: unknown[];
      imageUrls: string[];
      maxOutputTokens?: number;
    }
  | {
      kind: 'embedding';
      modelId: string;
      input?: S5EmbeddingInputItem[];
      /** @deprecated Use ordered input items. */
      texts?: string[];
      dimension: S5VectorDimension;
    }
  | {
      kind: 'rerank';
      modelId: string;
      query: string;
      candidates: unknown[];
    }
  | {
      kind: 'stt';
      modelId: string;
      audio: Uint8Array;
      mimeType: string;
    }
  | {
      kind: 'tts';
      modelId: string;
      text: string;
      voice?: string;
    };

export type S5ModelGatewayRequest = S5ModelInvocation & {
  workspaceId: string;
  knowledgeSpaceId: string | null;
  requestId: string;
  traceId: string;
  context: TenantContext;
  fallbackModelIds?: string[];
  resourceType?: 'space' | 'source';
  resourceId?: string;
  operation?: string;
  audit?: {
    promptVersion?: string;
    mediaItemCount?: number;
    totalBytes?: number;
    sourceVersion?: number;
  };
};

export type S5UsageUnit = 'token' | 'request' | 'second' | 'page' | 'image';

export interface S5GatewayUsageFact {
  workspaceId: string;
  knowledgeSpaceId: string | null;
  operation: string;
  requestId: string;
  traceId: string;
  modelId: string;
  kind: S5ModelType;
  attempt: number;
  eventSequence: number;
  quantity: number;
  unit: S5UsageUnit;
  inputTokens?: number;
  outputTokens?: number;
  status: number | null;
  fallbackUsed: boolean;
  provider: string;
  resourceType: 'space' | 'source';
  resourceId: string;
  intent?: boolean;
  promptVersion?: string;
  mediaItemCount?: number;
  totalBytes?: number;
  sourceVersion?: number;
}

export interface S5UsageRecorderPort {
  recordInvocationUsage(fact: S5GatewayUsageFact, context: TenantContext): Promise<boolean>;
}

export interface S10ModelQuotaPort {
  check(
    input: {
      operation: 'model';
      workspaceId: string;
      knowledgeSpaceId?: string;
      estimatedPointsMicros?: number;
    },
    context: TenantContext,
  ): Promise<void>;
  withModelSlot<T>(
    context: TenantContext,
    work: () => Promise<T>,
    estimatedPointsMicros?: number,
  ): Promise<T>;
}

export interface S5GatewayResult<T> {
  data: T;
  actualModelId: string;
  attempts: number;
  fallbackUsed: boolean;
  degraded: boolean;
  usage: {
    inputTokens: number;
    outputTokens: number;
    quantity: number;
  };
}

export interface S5ModelGatewayPort {
  invoke<T = unknown>(request: S5ModelGatewayRequest): Promise<S5GatewayResult<T>>;
}

export type S5ModelTransportFailureKind =
  | 'auth'
  | 'rate_limit'
  | 'provider'
  | 'timeout'
  | 'contract'
  | 'validation';

export class S5ModelTransportError extends Error {
  constructor(
    readonly kind: S5ModelTransportFailureKind,
    readonly status: number | null,
    readonly retryAfterMs: number | null = null,
    readonly safeReason = 'model_transport_failed',
  ) {
    super(safeReason);
    this.name = 'S5ModelTransportError';
  }
}

export interface S5ModelAdapterResponse<T> {
  data: T;
  status: number;
  quantity: number;
  usage: { inputTokens: number; outputTokens: number };
}

export interface S5ModelInvocationAdapterPort {
  invoke<T = unknown>(
    invocation: S5ModelInvocation,
    context: {
      workspaceId: string;
      requestId: string;
      traceId: string;
    },
  ): Promise<S5ModelAdapterResponse<T>>;
}

export interface S5KeyedLimiterPort {
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
}
