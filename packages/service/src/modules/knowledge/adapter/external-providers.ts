import { createHash } from 'node:crypto';
import { createKnowledgeError } from '@kb/contracts';

export const EXTERNAL_UNVERIFIED = 'EXTERNAL_UNVERIFIED' as const;

export interface AiproxyProviderConfig {
  kind: 'aiproxy';
  baseUrl: string;
  apiKeyRef: string;
  timeoutMs: number;
  status: typeof EXTERNAL_UNVERIFIED;
}

export interface OcrProviderConfig {
  kind: 'ocr';
  provider: 'paddle' | 'sangfor' | 'somark' | 'textin' | 'doc2x';
  endpoint: string;
  credentialRef: string;
  timeoutMs: number;
  fallbackProvider: string | null;
  status: typeof EXTERNAL_UNVERIFIED;
}

export interface ConnectorProviderConfig {
  kind: 'connector';
  provider: 'feishu' | 'yuque' | 'dingtalk';
  endpoint: string;
  appCredentialRef: string;
  tenantCredentialRef: string;
  timeoutMs: number;
  status: typeof EXTERNAL_UNVERIFIED;
}

export type ExternalProviderConfig =
  | AiproxyProviderConfig
  | OcrProviderConfig
  | ConnectorProviderConfig;

export interface ExternalModelDescriptor {
  modelId: string;
  type: 'llm' | 'embedding' | 'rerank' | 'vlm' | 'stt' | 'tts';
  capabilities: string[];
  dimension: 768 | 1024 | 1536 | 3072 | null;
}

export interface ExternalProviderError {
  kind: 'timeout' | 'auth' | 'rate_limit' | 'provider' | 'contract' | 'unavailable';
  retryable: boolean;
  status: number | null;
  safeMessage: string;
}

export interface OcrMockResult {
  text: string;
  pages: number;
  images: number;
}

export interface ConnectorMockResult {
  provider: 'feishu' | 'yuque' | 'dingtalk';
  items: Array<{ externalId: string; title: string; version: string }>;
  nextCursor: string | null;
}

const SENSITIVE_KEY = /token|secret|password|credential|authorization|api[-_]?key/i;

export function redactExternalValue(value: unknown, keyHint = ''): unknown {
  if (SENSITIVE_KEY.test(keyHint)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactExternalValue(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactExternalValue(item, key),
      ]),
    );
  }
  return value;
}

export function classifyExternalFailure(input: {
  status?: number | null;
  timeout?: boolean;
  contract?: boolean;
  message?: string;
}): ExternalProviderError {
  if (input.timeout) {
    return {
      kind: 'timeout',
      retryable: true,
      status: 504,
      safeMessage: 'The external provider timed out.',
    };
  }
  if (input.contract) {
    return {
      kind: 'contract',
      retryable: true,
      status: 502,
      safeMessage: 'The external provider response did not match its contract.',
    };
  }
  if (input.status === 401 || input.status === 403) {
    return {
      kind: 'auth',
      retryable: false,
      status: input.status,
      safeMessage: 'The external provider credential was rejected.',
    };
  }
  if (input.status === 429) {
    return {
      kind: 'rate_limit',
      retryable: true,
      status: 429,
      safeMessage: 'The external provider rate limit was reached.',
    };
  }
  if (input.status !== undefined && input.status !== null && input.status >= 500) {
    return {
      kind: 'unavailable',
      retryable: true,
      status: input.status,
      safeMessage: 'The external provider is unavailable.',
    };
  }
  return {
    kind: 'provider',
    retryable: false,
    status: input.status ?? null,
    safeMessage: 'The external provider rejected the request.',
  };
}

function providerError(
  config: ExternalProviderConfig,
  failure: ExternalProviderError,
  requestId: string,
) {
  return createKnowledgeError({
    code:
      failure.kind === 'timeout'
        ? 'KNOWLEDGE_DEPENDENCY_TIMEOUT'
        : failure.kind === 'rate_limit'
          ? 'KNOWLEDGE_RATE_LIMITED'
          : failure.kind === 'contract'
            ? 'KNOWLEDGE_PROVIDER_CONTRACT_INVALID'
            : 'KNOWLEDGE_DEPENDENCY_UNAVAILABLE',
    requestId,
    traceId: requestId,
    retryable: failure.retryable,
    details: {
      provider: config.kind,
      errorKind: failure.kind,
      status: failure.status,
      verification: EXTERNAL_UNVERIFIED,
    },
  });
}

export class AiproxyMockAdapter {
  constructor(private readonly config: AiproxyProviderConfig) {}

  async listModels(): Promise<ExternalModelDescriptor[]> {
    return [
      {
        modelId: 'mock-llm-general',
        type: 'llm',
        capabilities: ['chat', 'structured-output'],
        dimension: null,
      },
      {
        modelId: 'mock-embedding-768',
        type: 'embedding',
        capabilities: ['text-embedding'],
        dimension: 768,
      },
      {
        modelId: 'mock-embedding-1024',
        type: 'embedding',
        capabilities: ['text-embedding'],
        dimension: 1024,
      },
      {
        modelId: 'mock-embedding-1536',
        type: 'embedding',
        capabilities: ['text-embedding'],
        dimension: 1536,
      },
      {
        modelId: 'mock-embedding-3072',
        type: 'embedding',
        capabilities: ['text-embedding'],
        dimension: 3072,
      },
      {
        modelId: 'mock-rerank',
        type: 'rerank',
        capabilities: ['rerank'],
        dimension: null,
      },
    ];
  }

  async embed(
    input: { modelId: string; dimension: 768 | 1024 | 1536 | 3072; texts: string[] },
    requestId: string,
  ): Promise<number[][]> {
    const models = await this.listModels();
    const model = models.find(
      (entry) =>
        entry.modelId === input.modelId &&
        entry.type === 'embedding' &&
        entry.dimension === input.dimension,
    );
    if (!model) {
      throw providerError(this.config, classifyExternalFailure({ contract: true }), requestId);
    }
    return input.texts.map((text) => {
      const digest = createHash('sha256').update(text).digest();
      return Array.from(
        { length: input.dimension },
        (_, index) => ((digest[index % digest.length] ?? 0) - 127.5) / 127.5,
      );
    });
  }
}

export class OcrMockAdapter {
  constructor(private readonly config: OcrProviderConfig) {}

  async parse(
    input: { fileName: string; bytes: Uint8Array },
    requestId: string,
  ): Promise<OcrMockResult> {
    if (!this.config.fallbackProvider && input.bytes.byteLength === 0) {
      throw providerError(this.config, classifyExternalFailure({ status: 422 }), requestId);
    }
    return {
      text: `Mock OCR result for ${input.fileName}`,
      pages: 1,
      images: 0,
    };
  }
}

export class ConnectorMockAdapter {
  constructor(private readonly config: ConnectorProviderConfig) {}

  async catalog(_requestId: string): Promise<ConnectorMockResult> {
    const provider = this.config.provider;
    return {
      provider,
      items: [
        {
          externalId: `${provider}-doc-1`,
          title: `${provider} mock document`,
          version: '1',
        },
      ],
      nextCursor: null,
    };
  }

  async sync(input: { cursor: string | null }, requestId: string): Promise<ConnectorMockResult> {
    const catalog = await this.catalog(requestId);
    return { ...catalog, nextCursor: input.cursor };
  }
}
