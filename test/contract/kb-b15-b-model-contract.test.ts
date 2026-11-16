import { describe, expect, it } from 'vitest';
import {
  S5AiproxyHttpAdapter,
  type S5HttpRequest,
  type S5HttpResponse,
  type S5HttpTransportPort,
} from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';

const context = {
  workspaceId: 'ws-b15-contract',
  requestId: 'req-b15-contract',
  traceId: 'trace-b15-contract',
};

class ScriptedTransport implements S5HttpTransportPort {
  readonly requests: S5HttpRequest[] = [];

  constructor(private readonly responses: Array<unknown | Error>) {}

  async request<T>(input: S5HttpRequest): Promise<S5HttpResponse<T>> {
    this.requests.push(input);
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    return {
      status: 200,
      headers: {},
      data: next as T,
    };
  }
}

describe('L1-B15-B MODEL-003 provider response contract', () => {
  it('L1-B15-B-MODEL-003-P02 sends the OpenAI-compatible rerank shape and preserves provider order', async () => {
    const transport = new ScriptedTransport([
      {
        results: [
          { index: 1, relevance_score: 0.98 },
          { index: 0, relevance_score: 0.03 },
        ],
        usage: { prompt_tokens: 12, total_tokens: 12 },
      },
    ]);
    const adapter = new S5AiproxyHttpAdapter({
      baseUrl: 'https://aiproxy.example.invalid/base',
      token: 'fake-provider-token',
      transport,
    });

    const result = await adapter.invoke(
      {
        kind: 'rerank',
        modelId: 'rerank-openai',
        query: 'refund',
        candidates: ['refund policy', 'shipping policy'],
      },
      context,
    );

    expect(transport.requests[0]).toMatchObject({
      url: 'https://aiproxy.example.invalid/base/v1/rerank',
      headers: {
        Authorization: 'Bearer fake-provider-token',
        'X-Workspace-Id': context.workspaceId,
      },
      body: {
        model: 'rerank-openai',
        query: 'refund',
        documents: ['refund policy', 'shipping policy'],
      },
    });
    expect(result).toMatchObject({
      quantity: 12,
      usage: { inputTokens: 12, outputTokens: 0 },
    });
  });

  it('L1-B15-B-MODEL-003-P03 supports Alibaba native rerank output without mixing request protocols', async () => {
    const transport = new ScriptedTransport([
      {
        output: {
          results: [
            { index: 0, relevance_score: 0.9 },
            { index: 1, relevance_score: 0.2 },
          ],
        },
        usage: { prompt_tokens: 9 },
      },
    ]);
    const adapter = new S5AiproxyHttpAdapter({
      baseUrl: 'https://tokendance.example.invalid/gateway/v1',
      token: 'fake-provider-token',
      transport,
      providerOnly: ['alibaba'],
      rerankProtocol: 'alibaba-native',
    });

    await adapter.invoke(
      {
        kind: 'rerank',
        modelId: 'rerank-alibaba',
        query: 'refund',
        candidates: ['refund policy', 'shipping policy'],
      },
      context,
    );

    expect(transport.requests[0]).toMatchObject({
      url: 'https://tokendance.example.invalid/gateway/alibaba/text-rerank/v1',
      body: {
        model: 'rerank-alibaba',
        input: {
          query: 'refund',
          documents: ['refund policy', 'shipping policy'],
        },
        parameters: { top_n: 2 },
        provider: { only: ['alibaba'] },
      },
    });
  });

  it.each([
    [
      'duplicate-index',
      {
        results: [
          { index: 0, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.8 },
        ],
      },
    ],
    ['missing-score', { results: [{ index: 0 }] }],
    ['wrong-root', { output: [] }],
    ['non-finite-score', { results: [{ index: 0, relevance_score: Infinity }] }],
  ])(
    'L1-B15-B-MODEL-003-N07..10 rejects %s before it can enter search ranking',
    async (_label, payload) => {
      const adapter = new S5AiproxyHttpAdapter({
        baseUrl: 'https://aiproxy.example.invalid',
        token: 'fake-provider-token',
        transport: new ScriptedTransport([payload]),
      });

      await expect(
        adapter.invoke(
          {
            kind: 'rerank',
            modelId: 'rerank-openai',
            query: 'refund',
            candidates: ['refund policy', 'shipping policy'],
          },
          context,
        ),
      ).rejects.toMatchObject({ kind: 'contract' });
    },
  );
});

describe('L1-B15-B MODEL-004 model response contract', () => {
  it('L1-B15-B-MODEL-004-N01 rejects empty chat choice arrays as an invalid model response', async () => {
    const adapter = new S5AiproxyHttpAdapter({
      baseUrl: 'https://aiproxy.example.invalid',
      token: 'fake-provider-token',
      transport: new ScriptedTransport([{ choices: [] }]),
    });

    await expect(
      adapter.invoke(
        {
          kind: 'llm',
          modelId: 'llm-primary',
          messages: [{ role: 'user', content: 'return JSON' }],
          maxOutputTokens: 128,
        },
        context,
      ),
    ).rejects.toMatchObject({ kind: 'contract' });
  });

  it('L1-B15-B-MODEL-004-N02 keeps VLM image data in chat image_url parts instead of provider-specific fields', async () => {
    const transport = new ScriptedTransport([
      { choices: [{ message: { content: '{"caption":"refund diagram"}' } }] },
    ]);
    const adapter = new S5AiproxyHttpAdapter({
      baseUrl: 'https://aiproxy.example.invalid',
      token: 'fake-provider-token',
      transport,
    });

    await adapter.invoke(
      {
        kind: 'vlm',
        modelId: 'vlm-primary',
        messages: [{ role: 'user', content: 'Describe briefly.' }],
        imageUrls: ['https://assets.example.invalid/refund.png'],
        maxOutputTokens: 64,
      },
      context,
    );

    expect(transport.requests[0]?.body).toMatchObject({
      model: 'vlm-primary',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe briefly.' },
            {
              type: 'image_url',
              image_url: { url: 'https://assets.example.invalid/refund.png' },
            },
          ],
        },
      ],
    });
    expect(transport.requests[0]?.body).not.toHaveProperty('image_urls');
  });
});

describe('L1-B15-B MODEL-006 provider error contract', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limit'],
    [500, 'provider'],
    [503, 'provider'],
  ])(
    'L1-B15-B-MODEL-006-F01 classifies HTTP %i as %s without exposing provider text',
    async (status, kind) => {
      const transport: S5HttpTransportPort = {
        async request<T>() {
          return {
            status,
            headers: { 'retry-after': '1' },
            data: { error: 'sensitive-provider-body' } as T,
          };
        },
      };
      const adapter = new S5AiproxyHttpAdapter({
        baseUrl: 'https://aiproxy.example.invalid',
        token: 'never-log-this-token',
        transport,
      });

      await expect(
        adapter.invoke(
          {
            kind: 'llm',
            modelId: 'llm-primary',
            messages: [{ role: 'user', content: 'secret business prompt' }],
            maxOutputTokens: 32,
          },
          context,
        ),
      ).rejects.toMatchObject({ kind, status });
    },
  );
});
