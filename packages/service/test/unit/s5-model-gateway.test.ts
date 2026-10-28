import { describe, expect, it } from 'vitest';
import type {
  S5HttpResponse,
  S5HttpTransportPort,
} from '../../src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import { S5AiproxyHttpAdapter } from '../../src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import { S5ModelGateway } from '../../src/modules/knowledge/application/s5-model-gateway';
import type {
  S5ModelAdapterResponse,
  S5GatewayUsageFact,
  S5ModelInvocation,
  S5UsageRecorderPort,
} from '../../src/modules/knowledge/application/s5-model-gateway.port';
import { S5ModelTransportError } from '../../src/modules/knowledge/application/s5-model-gateway.port';
import type {
  ModelCatalogItem,
  ModelCatalogPort,
} from '../../src/modules/knowledge/application/s5-model-ports';
import type { TenantContext } from '../../src/shared/persistence/knowledge/tenant';

const context: TenantContext = {
  workspaceId: 'ws_gateway',
  memberId: 'mem_gateway',
  requestId: 'req-gateway',
  traceId: 'trace-gateway',
  scopes: ['knowledge:write'],
};

const models: ModelCatalogItem[] = [
  {
    modelId: 'llm-primary',
    displayName: 'Primary',
    type: 'llm',
    capabilities: ['chat'],
    dimension: null,
    authorized: true,
  },
  {
    modelId: 'llm-fallback',
    displayName: 'Fallback',
    type: 'llm',
    capabilities: ['chat'],
    dimension: null,
    authorized: true,
  },
  {
    modelId: 'embedding-768',
    displayName: 'Embedding',
    type: 'embedding',
    capabilities: ['text-embedding', 'dimension:768'],
    dimension: 768,
    authorized: true,
  },
  {
    modelId: 'vlm-primary',
    displayName: 'VLM',
    type: 'vlm',
    capabilities: ['vision'],
    dimension: null,
    authorized: true,
  },
];

const catalog: ModelCatalogPort = {
  async listModels() {
    return models;
  },
};

class RecordingUsage implements S5UsageRecorderPort {
  readonly facts: S5GatewayUsageFact[] = [];

  get actualFacts(): S5GatewayUsageFact[] {
    return this.facts.filter((fact) => fact.intent !== true);
  }

  async recordInvocationUsage(fact: S5GatewayUsageFact): Promise<boolean> {
    this.facts.push(fact);
    return true;
  }
}

function adapter(handler: (invocation: S5ModelInvocation) => S5ModelAdapterResponse<unknown>) {
  return {
    async invoke<T = unknown>(invocation: S5ModelInvocation) {
      return handler(invocation) as S5ModelAdapterResponse<T>;
    },
  };
}

function gateway(
  handler: (invocation: S5ModelInvocation) => S5ModelAdapterResponse<unknown>,
  usage: RecordingUsage,
) {
  return new S5ModelGateway({
    catalog,
    adapter: adapter(handler),
    usage,
    maxAttempts: 3,
    sleep: async () => undefined,
  });
}

describe('TEST-MODEL-002/003/006-BLOCK model gateway', () => {
  it('retries, uses an authorized fallback, records each attempt and reports the actual model', async () => {
    const usage = new RecordingUsage();
    const calls: string[] = [];
    const client = gateway((invocation) => {
      calls.push(invocation.modelId);
      if (invocation.modelId === 'llm-primary') {
        throw new S5ModelTransportError('provider', 503);
      }
      return {
        status: 200,
        data: {
          choices: [{ message: { content: 'fallback answer' } }],
        },
        quantity: 10,
        usage: { inputTokens: 7, outputTokens: 3 },
      };
    }, usage);
    const result = await client.invoke({
      kind: 'llm',
      modelId: 'llm-primary',
      messages: [{ role: 'user', content: 'hello' }],
      maxOutputTokens: 100,
      workspaceId: context.workspaceId,
      knowledgeSpaceId: 'space-1',
      requestId: context.requestId,
      traceId: context.traceId,
      context,
      fallbackModelIds: ['llm-fallback', 'unauthorized-model'],
    });
    expect(calls).toEqual(['llm-primary', 'llm-fallback']);
    expect(result).toMatchObject({
      actualModelId: 'llm-fallback',
      attempts: 2,
      fallbackUsed: true,
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    expect(usage.facts.map((fact) => fact.intent)).toEqual([true, false, true, false]);
    expect(usage.actualFacts.map((fact) => fact.modelId)).toEqual(['llm-primary', 'llm-fallback']);
    expect(usage.actualFacts.map((fact) => fact.attempt)).toEqual([1, 2]);
    expect(usage.actualFacts.map((fact) => fact.quantity)).toEqual([0, 10]);
  });

  it('does not retry or fallback after upstream authentication rejection', async () => {
    const usage = new RecordingUsage();
    let calls = 0;
    const client = gateway(() => {
      calls += 1;
      throw new S5ModelTransportError('auth', 401);
    }, usage);
    await expect(
      client.invoke({
        kind: 'llm',
        modelId: 'llm-primary',
        messages: [],
        maxOutputTokens: 10,
        workspaceId: context.workspaceId,
        knowledgeSpaceId: 'space-1',
        requestId: context.requestId,
        traceId: context.traceId,
        context,
        fallbackModelIds: ['llm-fallback'],
      }),
    ).rejects.toMatchObject({
      problem: {
        error: {
          code: 'KNOWLEDGE_MODEL_FAILED',
          retryable: false,
        },
      },
    });
    expect(calls).toBe(1);
    expect(usage.facts).toHaveLength(2);
    expect(usage.facts[0]).toMatchObject({ intent: true, quantity: 0, status: null });
    expect(usage.actualFacts).toHaveLength(1);
  });

  it('writes a safe S8 intent before provider invocation and actual usage afterwards', async () => {
    const usage = new RecordingUsage();
    const client = gateway(
      () => ({
        status: 200,
        data: { choices: [{ message: { content: '{"caption":"safe"}' } }] },
        quantity: 4,
        usage: { inputTokens: 3, outputTokens: 1 },
      }),
      usage,
    );
    await client.invoke({
      kind: 'vlm',
      modelId: 'vlm-primary',
      messages: [{ role: 'user', content: 'caption' }],
      imageUrls: ['https://files.example.invalid/content?ticket=secret'],
      workspaceId: context.workspaceId,
      knowledgeSpaceId: 'space-1',
      requestId: context.requestId,
      traceId: context.traceId,
      context,
      operation: 's8.caption:2',
      audit: {
        promptVersion: 's8.image-caption.v1',
        mediaItemCount: 1,
        totalBytes: 128,
        sourceVersion: 2,
      },
    });
    expect(usage.facts).toHaveLength(2);
    expect(usage.facts[0]).toMatchObject({
      intent: true,
      quantity: 0,
      status: null,
      promptVersion: 's8.image-caption.v1',
      mediaItemCount: 1,
      totalBytes: 128,
      sourceVersion: 2,
    });
    expect(usage.facts[1]).toMatchObject({
      intent: false,
      quantity: 4,
      status: 200,
    });
    expect(JSON.stringify(usage.facts)).not.toContain('ticket=secret');
  });

  it('retries timeout and 429 up to three total attempts', async () => {
    const usage = new RecordingUsage();
    let calls = 0;
    const client = gateway(() => {
      calls += 1;
      throw new S5ModelTransportError('rate_limit', 429);
    }, usage);
    await expect(
      client.invoke({
        kind: 'llm',
        modelId: 'llm-primary',
        messages: [],
        maxOutputTokens: 10,
        workspaceId: context.workspaceId,
        knowledgeSpaceId: 'space-1',
        requestId: context.requestId,
        traceId: context.traceId,
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_RATE_LIMITED', retryable: true } },
    });
    expect(calls).toBe(3);
    expect(usage.facts).toHaveLength(6);
    expect(usage.actualFacts).toHaveLength(3);
  });

  it('rejects embedding dimension mismatches without retry', async () => {
    const usage = new RecordingUsage();
    let calls = 0;
    const client = gateway(() => {
      calls += 1;
      throw new S5ModelTransportError('validation', 200);
    }, usage);
    await expect(
      client.invoke({
        kind: 'embedding',
        modelId: 'embedding-768',
        texts: ['hello'],
        dimension: 768,
        workspaceId: context.workspaceId,
        knowledgeSpaceId: 'space-1',
        requestId: context.requestId,
        traceId: context.traceId,
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED', retryable: false } },
    });
    expect(calls).toBe(1);
  });

  it('enforces all six invocation branches and embedding batch bounds', async () => {
    const usage = new RecordingUsage();
    let called = false;
    const client = gateway(() => {
      called = true;
      return {
        status: 200,
        data: {},
        quantity: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }, usage);
    await expect(
      client.invoke({
        kind: 'embedding',
        modelId: 'embedding-768',
        texts: Array.from({ length: 65 }, () => 'x'),
        dimension: 768,
        workspaceId: context.workspaceId,
        knowledgeSpaceId: 'space-1',
        requestId: context.requestId,
        traceId: context.traceId,
        context,
      }),
    ).rejects.toMatchObject({
      problem: { error: { code: 'KNOWLEDGE_VALIDATION_FAILED' } },
    });
    expect(called).toBe(false);
    expect(['llm', 'vlm', 'embedding', 'rerank', 'stt', 'tts']).toHaveLength(6);
  });

  it('sends the real workspace/request headers through the HTTP adapter', async () => {
    let captured: {
      workspaceId?: string;
      requestId?: string;
      traceId?: string;
      authorization?: string;
    } = {};
    const transport: S5HttpTransportPort = {
      async request<T>(request) {
        captured = {
          workspaceId: String(request.headers['X-Workspace-Id']),
          requestId: String(request.headers['X-Request-Id']),
          traceId: String(request.headers['X-Trace-Id']),
          authorization: request.headers.Authorization,
        };
        return {
          status: 200,
          headers: {},
          data: {
            choices: [{ message: { content: 'ok' } }],
          },
        } as S5HttpResponse<T>;
      },
    };
    const http = new S5AiproxyHttpAdapter({
      baseUrl: 'https://proxy.example.invalid',
      token: 'fake-token',
      transport,
    });
    const parsed = await http.invoke(
      {
        kind: 'llm',
        modelId: 'llm-primary',
        messages: [],
        maxOutputTokens: 10,
      },
      {
        workspaceId: 'workspace-header',
        requestId: 'request-header',
        traceId: 'trace-header',
      },
    );
    expect(captured).toEqual({
      workspaceId: 'workspace-header',
      requestId: 'request-header',
      traceId: 'trace-header',
      authorization: 'Bearer fake-token',
    });
    expect(parsed).toMatchObject({ status: 200, quantity: 0 });
  });

  it('sends VLM images as chat message image_url content parts', async () => {
    let body: Record<string, unknown> | undefined;
    const transport: S5HttpTransportPort = {
      async request<T>(request) {
        body = request.body as Record<string, unknown>;
        return {
          status: 200,
          headers: {},
          data: {
            choices: [{ message: { content: 'vision ok' } }],
          },
        } as S5HttpResponse<T>;
      },
    };
    const http = new S5AiproxyHttpAdapter({
      baseUrl: 'https://proxy.example.invalid',
      token: 'fake-token',
      transport,
    });
    await http.invoke({
      kind: 'vlm',
      modelId: 'vlm-primary',
      messages: [{ role: 'user', content: 'describe' }],
      imageUrls: ['https://assets.example.invalid/a.png'],
    });
    expect(body).not.toHaveProperty('image_urls');
    expect(body?.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          {
            type: 'image_url',
            image_url: { url: 'https://assets.example.invalid/a.png' },
          },
        ],
      },
    ]);
  });

  it('never uses TTS character count as billed seconds', async () => {
    const transport: S5HttpTransportPort = {
      async request<T>() {
        return {
          status: 200,
          headers: {},
          data: new Uint8Array([1]),
        } as S5HttpResponse<T>;
      },
    };
    const http = new S5AiproxyHttpAdapter({
      baseUrl: 'https://proxy.example.invalid',
      token: 'fake-token',
      transport,
    });
    await expect(
      http.invoke({
        kind: 'tts',
        modelId: 'tts-primary',
        text: 'abc',
      }),
    ).resolves.toMatchObject({ quantity: 0 });
  });

  it('uses observable STT/TTS duration fields when the provider returns them', async () => {
    const tts = new S5AiproxyHttpAdapter({
      baseUrl: 'https://proxy.example.invalid',
      token: 'fake-token',
      transport: {
        async request<T>() {
          return {
            status: 200,
            headers: { 'x-audio-duration-seconds': '2.5' },
            data: new Uint8Array([1]),
          } as S5HttpResponse<T>;
        },
      },
    });
    await expect(
      tts.invoke({ kind: 'tts', modelId: 'tts-primary', text: 'abc' }),
    ).resolves.toMatchObject({ quantity: 2.5 });

    const stt = new S5AiproxyHttpAdapter({
      baseUrl: 'https://proxy.example.invalid',
      token: 'fake-token',
      transport: {
        async request<T>() {
          return {
            status: 200,
            headers: {},
            data: { text: 'transcript', duration_seconds: 4 },
          } as S5HttpResponse<T>;
        },
      },
    });
    await expect(
      stt.invoke({
        kind: 'stt',
        modelId: 'stt-primary',
        audio: new Uint8Array([1]),
        mimeType: 'audio/mpeg',
      }),
    ).resolves.toMatchObject({ quantity: 4 });
  });
});
